import { createHash } from 'node:crypto';
import type { Db } from './db/client.js';
import {
  applySetDiff,
  deleteSets,
  FALLBACK_LANG,
  getCardHashes,
  getMeta,
  getSetFingerprints,
  pendingTexts,
  resetEmbeddings,
  saveVectors,
  setMeta,
  textKey,
  type MetaKey,
  type SetDiff,
} from './db/store.js';
import type { Embed } from './embed.js';
import { EmbeddingKind, EnergyType } from './enums.js';
import type { Attack, Card, CardSource, SetInfo } from './sources/types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETRY_MS = HOUR;
const EMBED_CHUNK = 50; // texts per embed call + write; progress survives crashes

export interface IngestDeps {
  db: Db;
  source: CardSource;
  embed: Embed;
  languages: string[];
  embeddingModel: string;
  intervalHours: number;
  fullRefreshDays: number;
}

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const sameList = (stored: string | undefined, now: string[]) =>
  stored === [...now].sort().join(',');

/** Stored data languages: configured plus `en` (canonical enums, fallback). */
const ingestLanguages = (languages: string[]) => [...new Set([...languages, FALLBACK_LANG])];

/** Unix ms when next ingest is due. ≤ now means due now. */
export function dueAt(meta: Partial<Record<MetaKey, string>>, deps: IngestDeps): number {
  const last = Number(meta.last_success_at);
  if (
    !meta.last_success_at ||
    !sameList(meta.languages, deps.languages) ||
    meta.source !== deps.source.id ||
    meta.embedding_model !== deps.embeddingModel
  ) {
    return 0;
  }
  const next = last + deps.intervalHours * HOUR;
  // last run failed: retry sooner, also after restart
  return meta.last_error ? Math.min(next, Number(meta.last_attempt_at) + RETRY_MS) : next;
}

const SYMBOLS: Record<string, EnergyType> = {
  G: EnergyType.Grass,
  R: EnergyType.Fire,
  W: EnergyType.Water,
  L: EnergyType.Lightning,
  P: EnergyType.Psychic,
  F: EnergyType.Fighting,
  D: EnergyType.Darkness,
  M: EnergyType.Metal,
  N: EnergyType.Dragon,
  C: EnergyType.Colorless,
};

/** `{R}` to `Fire`, so the embedding model understands energy symbols. */
const words = (s: string) => s.replace(/\{([A-Z])\}/g, (m, c: string) => SYMBOLS[c] ?? m);

/** Embeddable documents of one card text. */
export function documents(t: { effect: string | null; attacks: Attack[] }) {
  return [
    ...(t.effect ? [{ kind: EmbeddingKind.Effect, idx: 0, doc: words(t.effect) }] : []),
    ...t.attacks.map((a, idx) => ({
      kind: EmbeddingKind.Attack,
      idx,
      doc: [
        `${a.name}.`,
        a.cost.length ? `Cost: ${a.cost.join(', ')}.` : 'Cost: none.',
        a.damage ? `Damage: ${a.damage}.` : '',
        a.effect ? words(a.effect) : '',
      ]
        .filter(Boolean)
        .join(' '),
    })),
  ];
}

const embedHash = (t: { effect: string | null; attacks: Attack[] }) =>
  sha256(documents(t).map((d) => [d.kind, d.idx, d.doc]));

/** Compare fetched set with stored hashes. Pure. */
export function diffSet(
  info: SetInfo,
  fetched: Card[],
  stored: Awaited<ReturnType<typeof getCardHashes>>,
): SetDiff {
  const diff: SetDiff = {
    set: info,
    cards: [],
    texts: [],
    deleteCardIds: [],
    deleteTexts: [],
  };
  const seenCards = new Set<string>();
  const seenTexts = new Set<string>();

  for (const card of fetched) {
    seenCards.add(card.id);
    const { texts, ...row } = card;
    const hash = sha256(row);
    if (stored.cards.get(card.id) !== hash) diff.cards.push({ ...row, hash });

    for (const [lang, text] of Object.entries(texts)) {
      if (!text) continue;
      const key = textKey(card.id, lang);
      seenTexts.add(key);
      const old = stored.texts.get(key);
      const textHash = sha256(text);
      if (old?.hash === textHash) continue;
      const docsSame = old?.embedHash != null && old.embedHash === embedHash(text);
      diff.texts.push({
        row: {
          cardId: card.id,
          lang,
          ...text,
          hash: textHash,
          embedHash: docsSame ? old.embedHash : null,
        },
        resetVectors: !docsSame,
      });
    }
  }

  for (const id of stored.cards.keys()) if (!seenCards.has(id)) diff.deleteCardIds.push(id);
  for (const key of stored.texts.keys()) {
    const [cardId = '', lang = ''] = key.split('\u0000');
    if (seenCards.has(cardId) && !seenTexts.has(key)) diff.deleteTexts.push({ cardId, lang });
  }
  return diff;
}

/** Embed every text with embed_hash null. Chunked, so a crash loses one chunk at most. */
export async function embedPending(db: Db, embed: Embed, signal: AbortSignal) {
  let total = 0;
  for (;;) {
    const texts = await pendingTexts(db, EMBED_CHUNK);
    if (!texts.length) return total;
    const docs = texts.map((t) => documents(t));
    const vectors = await embed(
      docs.flat().map((d) => d.doc),
      signal,
    );
    let i = 0;
    await saveVectors(
      db,
      texts.map((t, n) => ({
        textId: t.id,
        embedHash: embedHash(t),
        vectors: (docs[n] ?? []).map((d) => ({
          kind: d.kind,
          idx: d.idx,
          vector: vectors[i++] ?? [],
        })),
      })),
    );
    total += texts.length;
  }
}

/** One full ingest run. Throws on failure; committed sets stay committed. */
export async function runIngest(deps: IngestDeps, signal: AbortSignal) {
  const { db, source } = deps;
  const started = Date.now();
  const meta = await getMeta(db);

  if (meta.embedding_model !== deps.embeddingModel) {
    if (meta.embedding_model) console.error(`ingest: embedding model changed, resetting vectors`);
    await resetEmbeddings(db);
    await setMeta(db, { embedding_model: deps.embeddingModel });
  }

  const full =
    !meta.last_full_refresh_at ||
    Number(meta.last_full_refresh_at) + deps.fullRefreshDays * DAY <= started;
  const langs = ingestLanguages(deps.languages);
  await setMeta(db, { last_attempt_at: String(started) });

  try {
    const sets = await source.listSets(langs, signal);
    const stored = await getSetFingerprints(db);
    let changed = 0;
    for (const info of sets) {
      if (!full && stored.get(info.id) === info.fingerprint) continue;
      const cards = await source.fetchSet(info.id, langs, signal);
      const diff = diffSet(info, cards, await getCardHashes(db, info.id));
      await applySetDiff(db, diff);
      changed++;
      console.error(
        `ingest: set ${info.id}: ${diff.cards.length} cards, ${diff.texts.length} texts upserted, ${diff.deleteCardIds.length + diff.deleteTexts.length} deleted`,
      );
    }
    const listed = new Set(sets.map((s) => s.id));
    await deleteSets(
      db,
      [...stored.keys()].filter((id) => !listed.has(id)),
    );
    const embedded = await embedPending(db, deps.embed, signal);

    await setMeta(db, {
      last_success_at: String(Date.now()),
      languages: [...deps.languages].sort().join(','),
      source: source.id,
      last_error: null,
      ...(full ? { last_full_refresh_at: String(started) } : {}),
    });
    console.error(
      `ingest: done in ${Math.round((Date.now() - started) / 1000)}s, ${changed}/${sets.length} sets fetched${full ? ' (full refresh)' : ''}, ${embedded} texts embedded`,
    );
  } catch (err) {
    await setMeta(db, { last_error: String(err) });
    throw err;
  }
}

/**
 * setTimeout to next due time, recomputed after each run. Single-flight via in-memory flag.
 * ponytail: in-memory lock, single instance only; lease row in meta if multi-instance needed.
 */
export function startScheduler(deps: IngestDeps) {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const schedule = (at: number) => {
    if (abort.signal.aborted) return;
    const delay = Math.max(0, at - Date.now());
    console.error(`ingest: next run ${new Date(Date.now() + delay).toISOString()}`);
    // clamp: setTimeout overflows above ~24.8 days
    timer = setTimeout(() => void tick(), Math.min(delay, 2 ** 31 - 1));
  };

  const tick = async () => {
    if (running || abort.signal.aborted) return;
    running = true;
    try {
      const due = dueAt(await getMeta(deps.db), deps);
      if (due <= Date.now()) await runIngest(deps, abort.signal);
    } catch (err) {
      console.error(`ingest: failed, retry in 1h:`, err);
    } finally {
      running = false;
    }
    try {
      schedule(dueAt(await getMeta(deps.db), deps));
    } catch (err) {
      console.error(`ingest: cannot read schedule, retry in 1h:`, err);
      schedule(Date.now() + RETRY_MS);
    }
  };

  void tick();
  return {
    stop() {
      abort.abort();
      clearTimeout(timer);
    },
  };
}
