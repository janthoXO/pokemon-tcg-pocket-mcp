import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { openDb, type Db } from './db/client.js';
import { cards, cardTexts, embeddings, sets, setNames } from './db/schema.js';
import { getMeta } from './db/store.js';
import type { Embed } from './embed.js';
import { Category, EnergyType, Rarity, Stage } from './enums.js';
import { diffSet, dueAt, runIngest, type IngestDeps } from './ingest.js';
import type { Card, CardSource, SetInfo } from './sources/types.js';

// ---- helpers ----

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Deterministic bag-of-words vector: hash each lowercase word into one of 32 buckets. */
function vectorOf(text: string): number[] {
  const v = new Array(32).fill(0) as number[];
  for (const word of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 32] = (v[h % 32] ?? 0) + 1;
  }
  return v;
}

function makeEmbed() {
  const calls: string[][] = [];
  const fn: Embed = (values) => {
    calls.push(values);
    return Promise.resolve(values.map(vectorOf));
  };
  return Object.assign(fn, { calls, count: () => calls.reduce((a, c) => a + c.length, 0) });
}

/** One Pokémon card, one attack, no ability, texts for each given lang. */
function cardFixture(
  id: string,
  setId: string,
  opts: { langs?: string[]; effect?: string | null; attackEffect?: string | null } = {},
): Card {
  const langs = opts.langs ?? ['en'];
  const texts: Card['texts'] = {};
  for (const lang of langs) {
    texts[lang] = {
      name: `${id}-${lang}`,
      effect: opts.effect ?? null,
      attacks: [
        {
          name: 'Tackle',
          cost: [EnergyType.Colorless],
          damage: '10',
          effect: opts.attackEffect ?? null,
        },
      ],
      image: null,
    };
  }
  return {
    id,
    setId,
    category: Category.Pokemon,
    type: EnergyType.Fire,
    stage: Stage.Basic,
    rarity: Rarity.OneDiamond,
    hp: 60,
    texts,
  };
}

interface FakeSource extends CardSource {
  fetchCalls: string[];
  listCalls: () => number;
  setsData: Map<string, Card[]>;
}

function makeSource(
  initial: Record<string, Card[]>,
  opts: { id?: string; languages?: string[] } = {},
): FakeSource {
  const setsData = new Map(Object.entries(initial));
  const fetchCalls: string[] = [];
  let listCalls = 0;
  return {
    id: opts.id ?? 'fake',
    languages: opts.languages ?? ['en', 'de'],
    listSets(): Promise<SetInfo[]> {
      listCalls++;
      return Promise.resolve(
        [...setsData.entries()].map(([id, cardList]) => ({
          id,
          fingerprint: sha256(cardList),
          names: { en: `Set ${id}` },
        })),
      );
    },
    fetchSet(setId, langs): Promise<Card[]> {
      fetchCalls.push(setId);
      const cardList = setsData.get(setId) ?? [];
      return Promise.resolve(
        cardList.map((c) => ({
          ...c,
          texts: Object.fromEntries(
            Object.entries(c.texts).filter(([lang]) => langs.includes(lang)),
          ),
        })),
      );
    },
    fetchCalls,
    listCalls: () => listCalls,
    setsData,
  };
}

function makeDeps(
  db: Db,
  source: CardSource,
  embed: Embed,
  overrides: Partial<IngestDeps> = {},
): IngestDeps {
  return {
    db,
    source,
    embed,
    languages: ['en'],
    embeddingModel: 'fake-v1',
    intervalHours: 24,
    fullRefreshDays: 100_000, // huge: never due for a full refresh after the first run
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

// ---- runIngest ----

void test('first run stores cards, texts, set names, embeds all texts, sets last_success_at', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({
    S1: [cardFixture('S1-1', 'S1'), cardFixture('S1-2', 'S1')],
    S2: [cardFixture('S2-1', 'S2')],
  });
  const deps = makeDeps(db, source, embed);

  await runIngest(deps, signal());

  assert.equal((await db.select().from(cards)).length, 3);
  assert.equal((await db.select().from(cardTexts)).length, 3);
  const names = await db.select().from(setNames);
  assert.ok(names.some((n) => n.setId === 'S1' && n.lang === 'en'));
  assert.ok(names.some((n) => n.setId === 'S2' && n.lang === 'en'));
  // one attack, no effect, per text => one embedded document per text
  assert.equal(embed.count(), 3);
  const meta = await getMeta(db);
  assert.ok(meta.last_success_at);
});

void test('second run with unchanged source makes zero fetchSet and zero embed calls', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({ S1: [cardFixture('S1-1', 'S1')], S2: [cardFixture('S2-1', 'S2')] });
  const deps = makeDeps(db, source, embed);

  await runIngest(deps, signal());
  assert.ok((await getMeta(db)).last_full_refresh_at);

  source.fetchCalls.length = 0;
  embed.calls.length = 0;
  await runIngest(deps, signal());

  assert.deepEqual(source.fetchCalls, []);
  assert.equal(embed.count(), 0);
});

void test('changing one attack effect refetches only that set and re-embeds only that text', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({
    S1: [cardFixture('S1-1', 'S1')],
    S2: [cardFixture('S2-1', 'S2')],
  });
  const deps = makeDeps(db, source, embed);
  await runIngest(deps, signal());

  const s2Before = (await db.select().from(cardTexts).where(eq(cardTexts.cardId, 'S2-1')))[0];
  assert.ok(s2Before?.embedHash);

  const s1Card = source.setsData.get('S1')?.[0];
  const attack = s1Card?.texts.en?.attacks[0];
  assert.ok(attack);
  attack.effect = 'Now burns the opponent.';

  source.fetchCalls.length = 0;
  embed.calls.length = 0;
  await runIngest(deps, signal());

  assert.deepEqual(source.fetchCalls, ['S1']);
  assert.equal(embed.count(), 1); // exactly one document (the changed attack) re-embedded

  const s2After = (await db.select().from(cardTexts).where(eq(cardTexts.cardId, 'S2-1')))[0];
  assert.equal(s2After?.embedHash, s2Before.embedHash); // untouched
});

void test('removing a card from source deletes its card, texts and embeddings', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({ S1: [cardFixture('S1-1', 'S1'), cardFixture('S1-2', 'S1')] });
  const deps = makeDeps(db, source, embed);
  await runIngest(deps, signal());

  const before = await db.select().from(cardTexts).where(eq(cardTexts.cardId, 'S1-2'));
  assert.equal(before.length, 1);
  const textId = before[0]?.id;
  assert.ok(textId);
  assert.ok((await db.select().from(embeddings).where(eq(embeddings.textId, textId))).length > 0);

  source.setsData.set('S1', [cardFixture('S1-1', 'S1')]);
  await runIngest(deps, signal());

  assert.deepEqual(await db.select().from(cards).where(eq(cards.id, 'S1-2')), []);
  assert.deepEqual(await db.select().from(cardTexts).where(eq(cardTexts.cardId, 'S1-2')), []);
  assert.deepEqual(await db.select().from(embeddings).where(eq(embeddings.textId, textId)), []);
});

void test('a set disappearing from listSets gets deleted', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({ S1: [cardFixture('S1-1', 'S1')], S2: [cardFixture('S2-1', 'S2')] });
  const deps = makeDeps(db, source, embed);
  await runIngest(deps, signal());
  assert.equal((await db.select().from(sets).where(eq(sets.id, 'S2'))).length, 1);

  source.setsData.delete('S2');
  await runIngest(deps, signal());

  assert.deepEqual(await db.select().from(sets).where(eq(sets.id, 'S2')), []);
  assert.deepEqual(await db.select().from(cards).where(eq(cards.setId, 'S2')), []);
  assert.deepEqual(await db.select().from(setNames).where(eq(setNames.setId, 'S2')), []);
});

void test('embedding model change re-embeds everything without refetching unchanged sets', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource({ S1: [cardFixture('S1-1', 'S1')], S2: [cardFixture('S2-1', 'S2')] });
  const deps = makeDeps(db, source, embed, { embeddingModel: 'model-v1' });
  await runIngest(deps, signal());

  source.fetchCalls.length = 0;
  embed.calls.length = 0;
  await runIngest({ ...deps, embeddingModel: 'model-v2' }, signal());

  assert.deepEqual(source.fetchCalls, []);
  assert.equal(embed.count(), 2); // both texts' one document each, re-embedded
});

void test('en text is ingested even when LANGUAGES excludes en', async () => {
  const db = await openDb(':memory:');
  const embed = makeEmbed();
  const source = makeSource(
    { S1: [cardFixture('S1-1', 'S1', { langs: ['en', 'de'] })] },
    { languages: ['en', 'de'] },
  );
  const deps = makeDeps(db, source, embed, { languages: ['de'] });

  await runIngest(deps, signal());

  const enTexts = await db
    .select()
    .from(cardTexts)
    .where(and(eq(cardTexts.cardId, 'S1-1'), eq(cardTexts.lang, 'en')));
  assert.equal(enTexts.length, 1);
  const deTexts = await db
    .select()
    .from(cardTexts)
    .where(and(eq(cardTexts.cardId, 'S1-1'), eq(cardTexts.lang, 'de')));
  assert.equal(deTexts.length, 1);
});

// ---- diffSet ----

void test('diffSet: new card is an insert, missing stored card is a delete', () => {
  const info: SetInfo = { id: 'S1', fingerprint: 'fp', names: { en: 'Set S1' } };
  const fetched: Card[] = [cardFixture('S1-1', 'S1')];
  const stored = { cards: new Map([['S1-2', 'oldhash']]), texts: new Map() };

  const diff = diffSet(info, fetched, stored);

  assert.equal(diff.cards.length, 1);
  assert.equal(diff.cards[0]?.id, 'S1-1');
  assert.deepEqual(diff.deleteCardIds, ['S1-2']);
  assert.equal(diff.texts.length, 1);
  assert.equal(diff.texts[0]?.resetVectors, true);
});

void test('diffSet: unchanged card hash produces no upsert', () => {
  const info: SetInfo = { id: 'S1', fingerprint: 'fp', names: { en: 'Set S1' } };
  const fetched: Card[] = [cardFixture('S1-1', 'S1')];
  const card = fetched[0] as Card;
  const row = {
    id: card.id,
    setId: card.setId,
    category: card.category,
    type: card.type,
    stage: card.stage,
    rarity: card.rarity,
    hp: card.hp,
  };
  const hash = sha256(row);
  const stored = { cards: new Map([['S1-1', hash]]), texts: new Map() };

  const diff = diffSet(info, fetched, stored);

  assert.equal(diff.cards.length, 0);
});

// ---- dueAt ----

const dueDeps = (overrides: Partial<IngestDeps> = {}) =>
  ({
    source: { id: 'fake' },
    languages: ['en'],
    embeddingModel: 'v1',
    intervalHours: 24,
    ...overrides,
  }) as IngestDeps;

void test('dueAt: never ran gives 0', () => {
  assert.equal(dueAt({}, dueDeps()), 0);
});

void test('dueAt: languages changed gives 0', () => {
  const meta = {
    last_success_at: '1000',
    languages: 'de',
    source: 'fake',
    embedding_model: 'v1',
  };
  assert.equal(dueAt(meta, dueDeps({ languages: ['en'] })), 0);
});

void test('dueAt: fresh run gives last_success_at + interval', () => {
  const meta = {
    last_success_at: '1000',
    languages: 'en',
    source: 'fake',
    embedding_model: 'v1',
  };
  const deps = dueDeps({ intervalHours: 24 });
  assert.equal(dueAt(meta, deps), 1000 + 24 * 3_600_000);
});

void test('dueAt: failed run retries within 1h of last_attempt_at', () => {
  const meta = {
    last_success_at: '1000',
    languages: 'en',
    source: 'fake',
    embedding_model: 'v1',
    last_error: 'boom',
    last_attempt_at: '2000',
  };
  const deps = dueDeps({ intervalHours: 24 });
  const expected = Math.min(1000 + 24 * 3_600_000, 2000 + 3_600_000);
  assert.equal(dueAt(meta, deps), expected);
  assert.equal(dueAt(meta, deps), 2000 + 3_600_000); // retry window is the binding one here
});
