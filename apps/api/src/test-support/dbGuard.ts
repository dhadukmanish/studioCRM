/**
 * Fail-closed guard every DB-backed suite runs BEFORE its first write (see the studio-db-safety
 * skill). It proves two things, and throws — failing the whole suite — if either is false:
 *
 *  1. the db client module was configured with TEST_DATABASE_URL (not the hosted URL from `.env`,
 *     which is what happened in the 2026-09-26 incident when a module was imported too early);
 *  2. the server the pool ACTUALLY reached is that database — same database name and port.
 *
 * Deliberately imports nothing from `db/`: a suite passes in the client it imported dynamically.
 */
export async function assertTestDatabase(
  client: { DATABASE_URL: string; sql: unknown },
  testDb: string | undefined,
): Promise<void> {
  if (!testDb) throw new Error('TEST_DATABASE_URL is not set — refusing to write test data');
  if (client.DATABASE_URL !== testDb) throw new Error('The db client is not connected to TEST_DATABASE_URL — refusing to write test data');
  const expected = new URL(testDb);
  const query = client.sql as (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;
  const rows = (await query`select current_database() as db, inet_server_port() as port`) as { db: string; port: number | null }[];
  const actual = rows[0];
  const expectedDb = decodeURIComponent(expected.pathname.replace(/^\//, ''));
  const expectedPort = Number(expected.port || 5432);
  if (!actual || actual.db !== expectedDb || (actual.port !== null && Number(actual.port) !== expectedPort)) {
    throw new Error('The connected database is not the TEST_DATABASE_URL database — refusing to write test data');
  }
}
