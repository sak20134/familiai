// Local Postgres (PGlite) so the whole app runs on your PC for free. Swap for a hosted Postgres later.

import { PGlite } from '@electric-sql/pglite';
import * as schema from '@familiai/core/db';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

export type Db = PgliteDatabase<typeof schema>;
export { schema };

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** `dataDir` undefined = in-memory database (used by tests). */
export async function createDb(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}
