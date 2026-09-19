import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { Category, EmbeddingKind, EnergyType, Rarity, Stage, values } from '../enums.js';
import type { Attack } from '../sources/types.js';

// References document relations only. FK enforcement is per connection in SQLite and not
// reliable over libsql-server HTTP, so store.ts deletes children explicitly.

export const sets = sqliteTable('sets', {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

export const setNames = sqliteTable(
  'set_names',
  {
    setId: text('set_id')
      .notNull()
      .references(() => sets.id),
    lang: text().notNull(),
    name: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.setId, t.lang] })],
);

export const cards = sqliteTable(
  'cards',
  {
    id: text().primaryKey(),
    setId: text('set_id')
      .notNull()
      .references(() => sets.id),
    category: text({ enum: values(Category) }).notNull(),
    type: text({ enum: values(EnergyType) }),
    stage: text({ enum: values(Stage) }),
    rarity: text({ enum: values(Rarity) }).notNull(),
    hp: integer(),
    hash: text().notNull(),
  },
  (t) => [
    index('cards_set_idx').on(t.setId),
    index('cards_filter_idx').on(t.type, t.stage, t.rarity, t.category),
  ],
);

export const cardTexts = sqliteTable(
  'card_texts',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    lang: text().notNull(),
    name: text().notNull(),
    effect: text(),
    attacks: text({ mode: 'json' }).$type<Attack[]>().notNull(),
    image: text(),
    hash: text().notNull(),
    embedHash: text('embed_hash'), // null = needs embed
  },
  (t) => [
    uniqueIndex('card_texts_card_lang_idx').on(t.cardId, t.lang),
    index('card_texts_lang_idx').on(t.lang),
  ],
);

export const embeddings = sqliteTable(
  'embeddings',
  {
    textId: integer('text_id')
      .notNull()
      .references(() => cardTexts.id),
    kind: text({ enum: values(EmbeddingKind) }).notNull(),
    idx: integer().notNull(), // attack index, 0 for effect
    embedding: blob().notNull(), // vector32(), no fixed dimension
  },
  (t) => [primaryKey({ columns: [t.textId, t.kind, t.idx] })],
);

export const meta = sqliteTable('meta', {
  key: text().primaryKey(),
  value: text().notNull(),
});
