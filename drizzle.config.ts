import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'turso', // = libSQL
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/cards.db',
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
