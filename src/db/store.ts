import { and, eq, getTableColumns, inArray, isNull, sql, type SQL, type Table } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Category, EmbeddingKind, EnergyType, Rarity, Stage } from '../enums.js';
import type { Db } from './client.js';
import { cards, cardTexts, embeddings, meta, setNames, sets } from './schema.js';

// All writes go through db.batch(): atomic, one round trip, and no interactive transaction
// (libsql opens a new connection per interactive transaction, which drops pragmas).

export const FALLBACK_LANG = 'en';

export type MetaKey =
  | 'embedding_model'
  | 'languages'
  | 'source'
  | 'last_success_at'
  | 'last_full_refresh_at'
  | 'last_attempt_at'
  | 'last_error';

export type CardRow = typeof cards.$inferInsert;
export type TextRow = typeof cardTexts.$inferInsert;

export interface SetDiff {
  set: { id: string; fingerprint: string; names: Partial<Record<string, string>> };
  cards: CardRow[]; // new or changed
  texts: { row: TextRow; resetVectors: boolean }[]; // new or changed
  deleteCardIds: string[];
  deleteTexts: { cardId: string; lang: string }[];
}

export interface StoredSet {
  cards: Map<string, string>; // card id -> hash
  texts: Map<string, { hash: string; embedHash: string | null }>; // textKey() -> hashes
}

export const textKey = (cardId: string, lang: string) => `${cardId}\u0000${lang}`;

type Batch = BatchItem<'sqlite'>[];

const run = async (db: Db, stmts: Batch) => {
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
};

const chunks = <T>(items: T[], size = 200): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** `excluded.<col>` for every column except `skip`, for ON CONFLICT DO UPDATE. */
const excluded = (table: Table, ...skip: string[]) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([k]) => !skip.includes(k))
      .map(([k, c]) => [k, sql.raw(`excluded.${c.name}`)]),
  );

const textIdsOf = (cardId: string, lang: string) =>
  sql`(select ${cardTexts.id} from ${cardTexts} where ${cardTexts.cardId} = ${cardId} and ${cardTexts.lang} = ${lang})`;

export async function getMeta(db: Db): Promise<Partial<Record<MetaKey, string>>> {
  const rows = await db.select().from(meta);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** null deletes the key. */
export async function setMeta(db: Db, entries: Partial<Record<MetaKey, string | null>>) {
  await run(
    db,
    Object.entries(entries).map(([key, value]) =>
      value == null
        ? db.delete(meta).where(eq(meta.key, key))
        : db.insert(meta).values({ key, value }).onConflictDoUpdate({
            target: meta.key,
            set: { value },
          }),
    ),
  );
}

export async function getSetFingerprints(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ id: sets.id, fingerprint: sets.fingerprint }).from(sets);
  return new Map(rows.map((r) => [r.id, r.fingerprint]));
}

export async function getCardHashes(db: Db, setId: string): Promise<StoredSet> {
  const cardRows = await db
    .select({ id: cards.id, hash: cards.hash })
    .from(cards)
    .where(eq(cards.setId, setId));
  const textRows = await db
    .select({
      cardId: cardTexts.cardId,
      lang: cardTexts.lang,
      hash: cardTexts.hash,
      embedHash: cardTexts.embedHash,
    })
    .from(cardTexts)
    .innerJoin(cards, eq(cards.id, cardTexts.cardId))
    .where(eq(cards.setId, setId));
  return {
    cards: new Map(cardRows.map((r) => [r.id, r.hash])),
    texts: new Map(textRows.map((r) => [textKey(r.cardId, r.lang), r])),
  };
}

function deleteCardsStmts(db: Db, where: SQL): Batch {
  const cardIds = db.select({ id: cards.id }).from(cards).where(where);
  const textIds = db
    .select({ id: cardTexts.id })
    .from(cardTexts)
    .where(inArray(cardTexts.cardId, cardIds));
  return [
    db.delete(embeddings).where(inArray(embeddings.textId, textIds)),
    db.delete(cardTexts).where(inArray(cardTexts.cardId, cardIds)),
    db.delete(cards).where(where),
  ];
}

/** One atomic batch: upsert changed rows, delete removed rows, save new fingerprint. */
export async function applySetDiff(db: Db, diff: SetDiff) {
  const { set } = diff;
  const names = Object.entries(set.names).flatMap(([lang, name]) =>
    name ? [{ setId: set.id, lang, name }] : [],
  );
  const stmts: Batch = [
    db
      .insert(sets)
      .values({ id: set.id, fingerprint: set.fingerprint, fetchedAt: Date.now() })
      .onConflictDoUpdate({
        target: sets.id,
        set: { fingerprint: set.fingerprint, fetchedAt: Date.now() },
      }),
    db.delete(setNames).where(eq(setNames.setId, set.id)),
    ...(names.length ? [db.insert(setNames).values(names)] : []),
  ];

  for (const { cardId, lang } of diff.deleteTexts) {
    stmts.push(
      db.delete(embeddings).where(inArray(embeddings.textId, textIdsOf(cardId, lang))),
      db.delete(cardTexts).where(and(eq(cardTexts.cardId, cardId), eq(cardTexts.lang, lang))),
    );
  }
  for (const ids of chunks(diff.deleteCardIds)) {
    stmts.push(...deleteCardsStmts(db, inArray(cards.id, ids)));
  }

  for (const rows of chunks(diff.cards)) {
    stmts.push(
      db
        .insert(cards)
        .values(rows)
        .onConflictDoUpdate({ target: cards.id, set: excluded(cards, 'id') }),
    );
  }

  for (const rows of chunks(diff.texts.map((t) => t.row))) {
    stmts.push(
      db
        .insert(cardTexts)
        .values(rows)
        .onConflictDoUpdate({
          target: [cardTexts.cardId, cardTexts.lang],
          set: excluded(cardTexts, 'id', 'cardId', 'lang'), // keep row id: embeddings use it
        }),
    );
  }
  for (const { row } of diff.texts.filter((t) => t.resetVectors)) {
    stmts.push(
      db.delete(embeddings).where(inArray(embeddings.textId, textIdsOf(row.cardId, row.lang))),
    );
  }

  await run(db, stmts);
}

/** Remove sets gone from source, with all their rows. */
export async function deleteSets(db: Db, ids: string[]) {
  if (!ids.length) return;
  await run(db, [
    ...deleteCardsStmts(db, inArray(cards.setId, ids)),
    db.delete(setNames).where(inArray(setNames.setId, ids)),
    db.delete(sets).where(inArray(sets.id, ids)),
  ]);
}

/** Embedding model changed: drop all vectors, mark all texts as needing embed. */
export async function resetEmbeddings(db: Db) {
  await run(db, [db.delete(embeddings), db.update(cardTexts).set({ embedHash: null })]);
}

export async function pendingTexts(db: Db, limit: number) {
  return db
    .select({
      id: cardTexts.id,
      effect: cardTexts.effect,
      attacks: cardTexts.attacks,
    })
    .from(cardTexts)
    .where(isNull(cardTexts.embedHash))
    .limit(limit);
}

export interface TextVectors {
  textId: number;
  embedHash: string;
  vectors: { kind: EmbeddingKind; idx: number; vector: number[] }[];
}

export async function saveVectors(db: Db, items: TextVectors[]) {
  await run(
    db,
    items.flatMap(({ textId, embedHash, vectors }) => [
      db.delete(embeddings).where(eq(embeddings.textId, textId)),
      ...(vectors.length
        ? [
            db.insert(embeddings).values(
              vectors.map((v) => ({
                textId,
                kind: v.kind,
                idx: v.idx,
                embedding: sql`vector32(${JSON.stringify(v.vector)})`,
              })),
            ),
          ]
        : []),
      db.update(cardTexts).set({ embedHash }).where(eq(cardTexts.id, textId)),
    ]),
  );
}

export interface CandidateFilter {
  lang: string;
  type?: EnergyType | undefined;
  category?: Category | undefined;
  rarity?: Rarity | undefined;
  stage?: Stage | undefined;
  setIds?: string[] | undefined;
}

/** Hard filters in SQL. One text row per card: requested language, else `en` fallback. */
export async function findCandidates(db: Db, f: CandidateFilter) {
  // alias() does not render its FROM clause inside raw sql, so name the alias by hand
  const langMatch = sql`(${cardTexts.lang} = ${f.lang} or (${cardTexts.lang} = ${FALLBACK_LANG} and not exists (select 1 from ${cardTexts} as "other" where "other"."card_id" = ${cardTexts.cardId} and "other"."lang" = ${f.lang})))`;
  return db
    .select({
      textId: cardTexts.id,
      lang: cardTexts.lang,
      name: cardTexts.name,
      effect: cardTexts.effect,
      attacks: cardTexts.attacks,
      image: cardTexts.image,
      id: cards.id,
      setId: cards.setId,
      category: cards.category,
      type: cards.type,
      stage: cards.stage,
      rarity: cards.rarity,
      hp: cards.hp,
    })
    .from(cardTexts)
    .innerJoin(cards, eq(cards.id, cardTexts.cardId))
    .where(
      and(
        langMatch,
        f.type && eq(cards.type, f.type),
        f.category && eq(cards.category, f.category),
        f.rarity && eq(cards.rarity, f.rarity),
        f.stage && eq(cards.stage, f.stage),
        f.setIds && inArray(cards.setId, f.setIds),
      ),
    )
    .orderBy(cards.id);
}

export type Candidate = Awaited<ReturnType<typeof findCandidates>>[number];

/** Cosine similarity per text for candidates only. Attack: best attack of card. */
export async function similarity(
  db: Db,
  textIds: number[],
  kind: EmbeddingKind,
  vector: number[],
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      textId: embeddings.textId,
      sim: sql<number>`max(1 - vector_distance_cos(${embeddings.embedding}, vector32(${JSON.stringify(vector)})))`,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.kind, kind),
        sql`${embeddings.textId} in (select value from json_each(${JSON.stringify(textIds)}))`,
      ),
    )
    .groupBy(embeddings.textId);
  return new Map(rows.map((r) => [r.textId, r.sim]));
}

/** Set names in requested language, else `en`, else set id. */
export async function listSetNames(db: Db, lang: string) {
  const req = alias(setNames, 'req');
  const en = alias(setNames, 'en');
  return db
    .select({ id: sets.id, name: sql<string>`coalesce(${req.name}, ${en.name}, ${sets.id})` })
    .from(sets)
    .leftJoin(req, and(eq(req.setId, sets.id), eq(req.lang, lang)))
    .leftJoin(en, and(eq(en.setId, sets.id), eq(en.lang, FALLBACK_LANG)))
    .orderBy(sets.id);
}
