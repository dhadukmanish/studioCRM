/**
 * A deliberately small fixed-window limiter for the one anonymous surface that does real work
 * (the public invoice link, `routes/publicInvoice.ts`). In memory, per process — enough to stop a
 * single client hammering the endpoint; it is not a distributed quota and does not try to be.
 */
export function fixedWindowLimiter({ limit, windowMs, maxKeys = 10_000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function allow(key: string, now = Date.now()): boolean {
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      // Drop expired windows before the map can grow without bound.
      if (hits.size >= maxKeys) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      if (hits.size >= maxKeys) hits.clear();
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
