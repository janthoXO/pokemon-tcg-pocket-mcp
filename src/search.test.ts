import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, type Db } from './db/client.js';
import type { Embed } from './embed.js';
import { Category, EnergyType, Rarity, Stage } from './enums.js';
import { runIngest, type IngestDeps } from './ingest.js';
import { NotReadyError, search, type SearchInput } from './search.js';
import type { Attack, Card, CardSource, SetInfo } from './sources/types.js';

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

function makeEmbed(): Embed {
  return (values) => Promise.resolve(values.map(vectorOf));
}

interface CardOpts {
  langs?: string[]; // languages this card has text for
  nameByLang?: Partial<Record<string, string>>;
  category?: Category;
  type?: EnergyType | null;
  stage?: Stage | null;
  rarity?: Rarity;
  hp?: number | null;
  effect?: string | null;
  attacks?: Attack[];
}

function cardFixture(id: string, setId: string, opts: CardOpts = {}): Card {
  const langs = opts.langs ?? ['en'];
  const texts: Card['texts'] = {};
  for (const lang of langs) {
    texts[lang] = {
      name: opts.nameByLang?.[lang] ?? id,
      effect: opts.effect ?? null,
      attacks: opts.attacks ?? [],
      image: null,
    };
  }
  return {
    id,
    setId,
    category: opts.category ?? Category.Pokemon,
    type: opts.type ?? null,
    stage: opts.stage ?? null,
    rarity: opts.rarity ?? Rarity.OneDiamond,
    hp: opts.hp ?? null,
    texts,
  };
}

function makeSource(bySet: Record<string, { name: string; cards: Card[] }>): CardSource {
  return {
    id: 'fake',
    languages: ['en', 'de'],
    listSets(): Promise<SetInfo[]> {
      return Promise.resolve(
        Object.entries(bySet).map(([id, s]) => ({
          id,
          fingerprint: sha256(s.cards),
          names: { en: s.name },
        })),
      );
    },
    fetchSet(setId, langs): Promise<Card[]> {
      const cards = bySet[setId]?.cards ?? [];
      return Promise.resolve(
        cards.map((c) => ({
          ...c,
          texts: Object.fromEntries(
            Object.entries(c.texts).filter(([lang]) => langs.includes(lang)),
          ),
        })),
      );
    },
  };
}

const input = (overrides: Partial<SearchInput> & { language: string }): SearchInput => ({
  limit: 10,
  offset: 0,
  ...overrides,
});

// ---- fixture data ----
// Set S1 "Genetic Apex": Charizard (en+de), Blastoise (en+de), Bulbasaur (en only, for the
// fallback test), Potion (trainer, effect only), Oddish (misspelling target).
// Set S2 "Mythical Island": Mew.

function buildSource(): CardSource {
  return makeSource({
    S1: {
      name: 'Genetic Apex',
      cards: [
        cardFixture('S1-001', 'S1', {
          langs: ['en', 'de'],
          nameByLang: { en: 'Charizard', de: 'Glurak' },
          type: EnergyType.Fire,
          stage: Stage.Stage2,
          rarity: Rarity.FourDiamond,
          hp: 180,
          attacks: [
            {
              name: 'Crimson Storm',
              cost: [EnergyType.Fire, EnergyType.Fire, EnergyType.Colorless],
              damage: '200',
              effect: 'Discard energy from this Pokemon.',
            },
          ],
        }),
        cardFixture('S1-002', 'S1', {
          langs: ['en', 'de'],
          nameByLang: { en: 'Blastoise', de: 'Turtok' },
          type: EnergyType.Water,
          stage: Stage.Stage1,
          rarity: Rarity.ThreeDiamond,
          hp: 150,
          attacks: [
            {
              name: 'Hydro Pump',
              cost: [EnergyType.Water, EnergyType.Water],
              damage: '150',
              effect: null,
            },
          ],
        }),
        cardFixture('S1-003', 'S1', {
          langs: ['en'], // no de text: language-fallback subject
          nameByLang: { en: 'Bulbasaur' },
          type: EnergyType.Grass,
          stage: Stage.Basic,
          rarity: Rarity.TwoDiamond,
          hp: 70,
          attacks: [{ name: 'Vine Whip', cost: [EnergyType.Grass], damage: '40', effect: null }],
        }),
        cardFixture('S1-004', 'S1', {
          langs: ['en', 'de'],
          nameByLang: { en: 'Potion', de: 'Trank' },
          category: Category.Item,
          rarity: Rarity.None,
          effect: 'Heal 20 damage from one of your Pokemon.',
          attacks: [],
        }),
        cardFixture('S1-005', 'S1', {
          langs: ['en'],
          nameByLang: { en: 'Oddish' },
          type: EnergyType.Grass,
          stage: Stage.Basic,
          rarity: Rarity.OneDiamond,
          hp: 50,
          attacks: [{ name: 'Absorb', cost: [EnergyType.Grass], damage: '20', effect: null }],
        }),
      ],
    },
    S2: {
      name: 'Mythical Island',
      cards: [
        cardFixture('S2-001', 'S2', {
          langs: ['en'],
          nameByLang: { en: 'Mew' },
          type: EnergyType.Psychic,
          stage: Stage.Basic,
          rarity: Rarity.Crown,
          hp: 60,
          attacks: [{ name: 'Psywave', cost: [EnergyType.Psychic], damage: '30', effect: null }],
        }),
      ],
    },
  });
}

void describe('search (seeded db)', () => {
  let db: Db;

  before(async () => {
    db = await openDb(':memory:');
    const deps: IngestDeps = {
      db,
      source: buildSource(),
      embed: makeEmbed(),
      languages: ['en', 'de'],
      embeddingModel: 'fake-v1',
      intervalHours: 24,
      fullRefreshDays: 100_000,
    };
    await runIngest(deps, new AbortController().signal);
  });

  void test('only language given returns all cards up to limit, sorted by id, no score field', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', limit: 10 }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-001', 'S1-002', 'S1-003', 'S1-004', 'S1-005', 'S2-001'],
    );
    for (const r of res.results) assert.equal('score' in r, false);
  });

  void test('type filter narrows to matching type', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', type: EnergyType.Fire }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-001'],
    );
  });

  void test('category filter narrows to matching category', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', category: Category.Item }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-004'],
    );
  });

  void test('rarity filter narrows to matching rarity', async () => {
    const res = await search(
      db,
      makeEmbed(),
      input({ language: 'en', rarity: Rarity.FourDiamond }),
    );
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-001'],
    );
  });

  void test('stage filter as enum narrows to matching stage', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', stage: Stage.Stage2 }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-001'],
    );
  });

  void test('stage filter as int (2 = Stage2) narrows the same way', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', stage: 2 }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-001'],
    );
  });

  void test('stage filter as int 0 (Basic) matches all basic-stage cards', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', stage: 0 }));
    assert.deepEqual(res.results.map((r) => r.id).sort(), ['S1-003', 'S1-005', 'S2-001']);
  });

  void test('null/omitted fields act as wildcard: trainer with null type/stage still returned', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en' }));
    assert.ok(res.results.some((r) => r.id === 'S1-004'));
  });

  void test('set filter by exact id', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', set: 'S1' }));
    assert.deepEqual(res.results.map((r) => r.id).sort(), [
      'S1-001',
      'S1-002',
      'S1-003',
      'S1-004',
      'S1-005',
    ]);
  });

  void test('set filter by fuzzy set name', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', set: 'Genetc Apex' }));
    assert.ok(res.results.length > 0);
    assert.ok(res.results.every((r) => r.set.id === 'S1'));
  });

  void test('set filter with unknown set name gives zero results', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', set: 'Qwertyuiop Zzz' }));
    assert.deepEqual(res.results, []);
  });

  void test('name fuzzy match finds a slightly misspelled name', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', name: 'Oddush' }));
    assert.ok(res.results.some((r) => r.id === 'S1-005'));
  });

  void test('attack semantic ranking: query sharing words ranks that card first', async () => {
    const res = await search(
      db,
      makeEmbed(),
      input({ language: 'en', attack: 'Crimson Storm energy discard' }),
    );
    assert.ok(res.results.length > 0);
    assert.equal(res.results[0]?.id, 'S1-001');
  });

  void test('effect semantic ranking: cards without an effect document drop out', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', effect: 'heal damage' }));
    assert.deepEqual(
      res.results.map((r) => r.id),
      ['S1-004'],
    );
  });

  void test('language fallback: en-only card returned for de with fallbackLanguage and en name', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'de', limit: 50 }));
    const bulbasaur = res.results.find((r) => r.id === 'S1-003');
    assert.ok(bulbasaur);
    assert.equal(bulbasaur.fallbackLanguage, 'en');
    assert.equal(bulbasaur.name, 'Bulbasaur');
  });

  void test('language fallback: card with de text returns de text without fallbackLanguage', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'de', limit: 50 }));
    const charizard = res.results.find((r) => r.id === 'S1-001');
    assert.ok(charizard);
    assert.equal('fallbackLanguage' in charizard, false);
    assert.equal(charizard.name, 'Glurak');
  });

  void test('paging: limit 2 walks all cards via nextOffset', async () => {
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const res = await search(db, makeEmbed(), input({ language: 'en', limit: 2, offset }));
      assert.equal(res.total, 6);
      ids.push(...res.results.map((r) => r.id));
      if (res.nextOffset === undefined) {
        assert.equal('nextOffset' in res, false);
        break;
      }
      offset = res.nextOffset;
    }
    assert.deepEqual(ids, ['S1-001', 'S1-002', 'S1-003', 'S1-004', 'S1-005', 'S2-001']);
  });

  void test('paging: offset beyond total returns empty page with no nextOffset', async () => {
    const res = await search(db, makeEmbed(), input({ language: 'en', limit: 2, offset: 100 }));
    assert.deepEqual(res.results, []);
    assert.equal(res.total, 6);
    assert.equal('nextOffset' in res, false);
  });
});

void test('search throws NotReadyError before first ingest', async () => {
  const db = await openDb(':memory:');
  await assert.rejects(() => search(db, makeEmbed(), input({ language: 'en' })), NotReadyError);
});
