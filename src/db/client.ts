import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Connect and migrate. Retries so compose startup order does not matter. */
export async function openDb(url: string, authToken?: string, attempts = 10): Promise<Db> {
  if (url.startsWith('file:')) {
    await mkdir(dirname(url.slice('file:'.length)), { recursive: true });
  }
  const client = createClient({ url, authToken });
  const db = drizzle(client, { schema });
  for (let i = 1; ; i++) {
    try {
      if (url.startsWith('file:')) {
        // WAL persists in file. busy_timeout is per connection; store uses no interactive
        // transactions, so the client keeps this one connection.
        await client.execute('PRAGMA journal_mode = WAL');
        await client.execute('PRAGMA busy_timeout = 5000');
      }
      await migrate(db, { migrationsFolder });
      return db;
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`DB not ready (${String(err)}), retry ${i}/${attempts - 1} in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
