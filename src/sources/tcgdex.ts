import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Category, EnergyType, parseEnum, Rarity, Stage } from '../enums.js';
import type { Attack, Card, CardSource, CardText, Language, SetInfo } from './types.js';

const BASE = 'https://api.tcgdex.net/v2';
const SERIES = 'tcgp';
const CANONICAL = 'en'; // localized enum values are unreliable ('Feuer', 'Quatre Diamant' on de)
const CONCURRENCY = 8;
const RETRIES = 4;

const Brief = z.object({ id: z.string(), name: z.string(), image: z.string().optional() });
const SeriesRes = z.object({ sets: z.array(z.object({ id: z.string(), name: z.string() })) });
const SetRes = z.object({
  id: z.string(),
  name: z.string(),
  cardCount: z.object({ total: z.number() }).partial().optional(),
  cards: z.array(Brief),
});
const CardRes = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  trainerType: z.string().optional(),
  rarity: z.string().optional(),
  hp: z.number().optional(),
  types: z.array(z.string()).optional(),
  stage: z.string().optional(),
  effect: z.string().optional(),
  image: z.string().optional(),
  // localized records sometimes miss ability or attack fields: fall back to en field
  abilities: z
    .array(z.object({ name: z.string().optional(), effect: z.string().optional() }))
    .optional(),
  attacks: z
    .array(
      z.object({
        name: z.string().optional(),
        cost: z.array(z.string()).optional(),
        damage: z.union([z.string(), z.number()]).optional(),
        effect: z.string().optional(),
      }),
    )
    .optional(),
});
type CardRes = z.infer<typeof CardRes>;
type SetRes = z.infer<typeof SetRes>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason as Error);
    });
  });

/** GET JSON. 404 gives null. Retries 429, 5xx and network errors with backoff. */
async function get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    let retryable: string;
    try {
      const res = await fetch(`${BASE}${path}`, {
        signal,
        headers: { 'User-Agent': 'pokemon-tcg-pocket-mcp (+https://github.com/janthoXO)' },
      });
      if (res.status === 404) return null;
      if (res.ok) return schema.parse(await res.json());
      if (res.status !== 429 && res.status < 500) throw new Error(`GET ${path}: ${res.status}`);
      retryable = `HTTP ${res.status}`;
    } catch (err) {
      if (signal.aborted || !(err instanceof TypeError)) throw err; // TypeError = network error
      retryable = err.message;
    }
    if (attempt >= RETRIES) throw new Error(`GET ${path}: ${retryable} after ${RETRIES} retries`);
    await sleep(1000 * 2 ** attempt, signal);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const withCanonical = (langs: Language[]) => [...new Set([CANONICAL, ...langs])];

/** All sets of the series per language. Sets missing in a language are absent there. */
async function fetchSets(langs: Language[], signal: AbortSignal) {
  const bySet = new Map<string, Map<Language, SetRes>>();
  for (const lang of withCanonical(langs)) {
    const series = await get(`/${lang}/series/${SERIES}`, SeriesRes, signal);
    const sets = await mapLimit(series?.sets ?? [], CONCURRENCY, (s) =>
      get(`/${lang}/sets/${s.id}`, SetRes, signal),
    );
    for (const set of sets) {
      if (!set) continue;
      const perLang = bySet.get(set.id) ?? new Map<Language, SetRes>();
      perLang.set(lang, set);
      bySet.set(set.id, perLang);
    }
  }
  return bySet;
}

function fingerprint(perLang: Map<Language, SetRes>) {
  const rows = [...perLang].flatMap(([lang, set]) => [
    [lang, set.cardCount?.total ?? null],
    ...set.cards.map((c) => [lang, c.id, c.name, c.image ?? null]),
  ]);
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const energy = (s: string | undefined) => parseEnum(EnergyType, s);

function category(en: CardRes): Category | undefined {
  return en.category === 'Pokemon'
    ? Category.Pokemon
    : en.category === 'Trainer'
      ? parseEnum(Category, en.trainerType)
      : undefined;
}

function text(card: CardRes, en: CardRes): CardText {
  const effect = card.abilities?.length
    ? card.abilities
        .map((a, i) => {
          const name = a.name ?? en.abilities?.[i]?.name;
          const effect = a.effect ?? en.abilities?.[i]?.effect ?? '';
          return name ? `${name}: ${effect}` : effect;
        })
        .join('\n')
    : (card.effect ?? null);
  const attacks: Attack[] = (card.attacks ?? []).map((a, i) => ({
    name: a.name ?? en.attacks?.[i]?.name ?? '',
    cost: (en.attacks?.[i]?.cost ?? []).flatMap((c) => energy(c) ?? []),
    damage: a.damage == null || a.damage === '' ? null : String(a.damage),
    effect: a.effect ?? en.attacks?.[i]?.effect ?? null,
  }));
  return { name: card.name, effect, attacks, image: card.image ? `${card.image}/high.webp` : null };
}

/** Canonical fields from `en`. Unknown enum value: warn and skip card. */
function normalize(setId: string, byLang: Map<Language, CardRes>): Card | null {
  const en = byLang.get(CANONICAL);
  if (!en) return null;
  const cat = category(en);
  const rarity =
    en.rarity === undefined ? undefined : parseEnum(Rarity, en.rarity.replace(/\s+/g, ''));
  const type = en.types?.[0] === undefined ? null : energy(en.types[0]);
  const stage = en.stage === undefined ? null : parseEnum(Stage, en.stage.replace(/\s+/g, ''));
  if (!cat || !rarity || type === undefined || stage === undefined) {
    console.warn(
      `tcgdex: skip ${en.id}, unknown value (category=${en.category}/${String(en.trainerType)} rarity=${String(en.rarity)} type=${String(en.types)} stage=${String(en.stage)})`,
    );
    return null;
  }
  return {
    id: en.id,
    setId,
    category: cat,
    type,
    stage,
    rarity,
    hp: en.hp ?? null,
    texts: Object.fromEntries([...byLang].map(([lang, card]) => [lang, text(card, en)])),
  };
}

export const tcgdex: CardSource = {
  id: 'tcgdex',
  languages: ['en', 'fr', 'de', 'es', 'it', 'pt-br'],

  async listSets(langs, signal): Promise<SetInfo[]> {
    const bySet = await fetchSets(langs, signal);
    return [...bySet].map(([id, perLang]) => ({
      id,
      fingerprint: fingerprint(perLang),
      names: Object.fromEntries([...perLang].map(([lang, set]) => [lang, set.name])),
    }));
  },

  async fetchSet(setId, langs, signal): Promise<Card[]> {
    const jobs: { lang: Language; id: string }[] = [];
    for (const lang of withCanonical(langs)) {
      const set = await get(`/${lang}/sets/${setId}`, SetRes, signal);
      for (const c of set?.cards ?? []) jobs.push({ lang, id: c.id });
    }
    const fetched = await mapLimit(jobs, CONCURRENCY, async ({ lang, id }) => {
      try {
        const card = await get(`/${lang}/cards/${encodeURIComponent(id)}`, CardRes, signal);
        if (card) return { lang, card };
        console.warn(`tcgdex: skip ${lang}/${id}, listed in set but 404`);
      } catch (err) {
        if (!(err instanceof z.ZodError)) throw err;
        console.warn(`tcgdex: skip ${lang}/${id}, unexpected shape: ${z.prettifyError(err)}`);
      }
      return null;
    });
    const byCard = new Map<string, Map<Language, CardRes>>();
    for (const { lang, card } of fetched.flatMap((f) => f ?? [])) {
      const perLang = byCard.get(card.id) ?? new Map<Language, CardRes>();
      perLang.set(lang, card);
      byCard.set(card.id, perLang);
    }
    return [...byCard.values()].flatMap((perLang) => normalize(setId, perLang) ?? []);
  },
};
