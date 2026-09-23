import type { ZodTypeAny, output } from 'zod';
import { AppError } from './errors';

/**
 * The single entry point for request validation. Returns the schema's OUTPUT type — schemas
 * here use `z.preprocess`, whose input type is `unknown`, so inferring from the input side
 * would hand every caller an untyped body.
 */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message, expected: (i as any).expected }));
    throw new AppError('VAL_001', 'Validation failed', 400, details);
  }
  return r.data;
}
