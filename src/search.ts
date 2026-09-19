import Fuse from 'fuse.js';
import { z } from 'zod';
import type { Db } from './db/client.js';
import { findCandidates, getMeta, listSetNames, similarity, type Candidate } from './db/store.js';
import type { Embed } from './embed.js';
import { Category, EmbeddingKind, EnergyType, Rarity, Stage } from './enums.js';

const FUZZY_THRESHOLD = 0.4;
const STAGES = [Stage.Basic, Stage.Stage1, Stage.Stage2];

export const searchInput = (languages: [string, ...string[]]) =>
  z.object({
    language: z.enum(languages).describe('Language of card texts and of name/set queries.'),
    name: z.string().nullish().describe('Card name, fuzzy matched.'),
    type: z.enum(EnergyType).nullish().describe('Pokémon type.'),
    category: z.enum(Category).nullish(),
    effect: z.string().nullish().describe('Semantic search over ability and trainer effect texts.'),
    attack: z
      .string()
      .nullish()
      .describe('Semantic search over attacks (name, energy cost, damage, effect).'),
    set: z.string().nullish().describe('Set id (e.g. "A1") or fuzzy set name.'),
    rarity: z.enum(Rarity).nullish(),
    stage: z
      .union([z.enum(Stage), z.number().int().min(0).max(2)])
      .nullish()
      .describe('Evolution stage, name or 0-2.'),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Number of results to skip, for paging. Use nextOffset from the previous call.'),
  });

export type SearchInput = z.infer<ReturnType<typeof searchInput>>;

export class NotReadyError extends Error {
  constructor() {
    super('Card data still loading, try again in a minute');
  }
}

async function resolveSets(db: Db, lang: string, query: string) {
  const sets = await listSetNames(db, lang);
  const exact = sets.find((s) => s.id.toLowerCase() === query.trim().toLowerCase());
  if (exact) return [exact.id];
  return new Fuse(sets, { keys: ['name'], threshold: FUZZY_THRESHOLD, ignoreLocation: true })
    .search(query)
    .map((r) => r.item.id);
}

const toResult = (c: Candidate, lang: string, setNames: Map<string, string>) => ({
  id: c.id,
  language: lang,
  ...(c.lang !== lang ? { fallbackLanguage: c.lang } : {}),
  name: c.name,
  category: c.category,
  type: c.type,
  stage: c.stage,
  rarity: c.rarity,
  hp: c.hp,
  set: { id: c.setId, name: setNames.get(c.setId) ?? c.setId },
  effect: c.effect,
  attacks: c.attacks,
  image: c.image,
});

export async function search(db: Db, embed: Embed, input: SearchInput) {
  const meta = await getMeta(db);
  if (!meta.last_success_at) throw new NotReadyError();
  const lang = input.language;

  const setIds = input.set ? await resolveSets(db, lang, input.set) : undefined;
  let candidates = await findCandidates(db, {
    lang,
    type: input.type ?? undefined,
    category: input.category ?? undefined,
    rarity: input.rarity ?? undefined,
    stage: typeof input.stage === 'number' ? STAGES[input.stage] : (input.stage ?? undefined),
    setIds,
  });

  // per text id: similarity of each given ranking field
  const sims = new Map<number, number[]>(candidates.map((c) => [c.textId, []]));

  if (input.name) {
    const hits = new Fuse(candidates, {
      keys: ['name'],
      threshold: FUZZY_THRESHOLD,
      ignoreLocation: true,
      includeScore: true,
    }).search(input.name);
    for (const h of hits) sims.get(h.item.textId)?.push(1 - (h.score ?? 0));
    const hitIds = new Set(hits.map((h) => h.item.textId));
    candidates = candidates.filter((c) => hitIds.has(c.textId));
  }

  const semantic = (
    [
      [EmbeddingKind.Effect, input.effect],
      [EmbeddingKind.Attack, input.attack],
    ] as const
  ).filter((q): q is readonly [EmbeddingKind, string] => Boolean(q[1]));
  if (semantic.length && candidates.length) {
    const vectors = await embed(semantic.map(([, q]) => q));
    for (const [i, [kind]] of semantic.entries()) {
      const bySim = await similarity(
        db,
        candidates.map((c) => c.textId),
        kind,
        vectors[i] ?? [],
      );
      // card without such document is no answer to the query
      candidates = candidates.filter((c) => bySim.has(c.textId));
      for (const c of candidates) sims.get(c.textId)?.push(bySim.get(c.textId) ?? 0);
    }
  }

  const ranked = input.name || semantic.length;
  const score = (c: Candidate) => {
    const s = sims.get(c.textId) ?? [];
    return s.reduce((a, b) => a + b, 0) / (s.length || 1);
  };
  // ponytail: score = plain mean of sims, add per-field weights when ranking feels off
  const all = ranked
    ? candidates
        .map((c) => ({ c, score: score(c) }))
        .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
    : candidates.map((c) => ({ c, score: undefined }));
  const end = input.offset + input.limit;
  const top = all.slice(input.offset, end);

  const setNames = new Map((await listSetNames(db, lang)).map((s) => [s.id, s.name]));
  return {
    results: top.map(({ c, score }) => ({
      ...toResult(c, lang, setNames),
      ...(score === undefined ? {} : { score: Math.round(score * 1000) / 1000 }),
    })),
    total: all.length,
    ...(end < all.length ? { nextOffset: end } : {}),
    dataUpdatedAt: new Date(Number(meta.last_success_at)).toISOString(),
  };
}
