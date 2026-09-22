import type { ZodSchema } from 'zod';
import { AppError } from './errors';

export function parse<T>(schema: ZodSchema<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message, expected: (i as any).expected }));
    throw new AppError('VAL_001', 'Validation failed', 400, details);
  }
  return r.data;
}
