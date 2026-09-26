import { describe, it, expect } from 'vitest';
import { assertTestDatabase } from './dbGuard';

/** A stand-in for the db client: the URL it was built with and the server it "reaches". */
const fakeClient = (url: string, reached: { db: string; port: number | null }) => ({
  DATABASE_URL: url,
  sql: async () => [reached],
});
const TEST = 'postgres://postgres@127.0.0.1:55432/studio_test';

describe('assertTestDatabase — DB suites fail closed', () => {
  it('passes only when the client URL and the reached server are the throwaway database', async () => {
    await expect(assertTestDatabase(fakeClient(TEST, { db: 'studio_test', port: 55432 }), TEST)).resolves.toBeUndefined();
  });

  it('refuses when TEST_DATABASE_URL is not set', async () => {
    await expect(assertTestDatabase(fakeClient(TEST, { db: 'studio_test', port: 55432 }), undefined)).rejects.toThrow(/refusing/);
  });

  it('refuses when the client was built with another URL (the hosted .env one)', async () => {
    await expect(assertTestDatabase(fakeClient('postgres://u:p@hosted.example:6432/live', { db: 'studio_test', port: 55432 }), TEST)).rejects.toThrow(/not connected to TEST_DATABASE_URL/);
  });

  it('refuses when the server actually reached is a different database or port', async () => {
    await expect(assertTestDatabase(fakeClient(TEST, { db: 'live', port: 55432 }), TEST)).rejects.toThrow(/refusing/);
    await expect(assertTestDatabase(fakeClient(TEST, { db: 'studio_test', port: 6432 }), TEST)).rejects.toThrow(/refusing/);
  });
});
