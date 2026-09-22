import { z } from 'zod';
import { GST_RATES } from '../enums.js';

/**
 * Item Master — what a studio sells or produces (Photography, Album Printing, ...).
 * Only the rate is stored; tax is calculated by whatever bills the item later.
 */
/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const ITEM_LIMITS = { itemName: 120, hsnCode: 20 } as const;

export const itemSchema = z.object({
  itemName: z.string().trim().min(1, 'Item name is required').max(ITEM_LIMITS.itemName, `Item name cannot exceed ${ITEM_LIMITS.itemName} characters`),
  /** Text, never a number: HSN codes are identifiers and leading zeros matter. */
  hsnCode: z.string().trim().min(1, 'HSN code is required').max(ITEM_LIMITS.hsnCode, `HSN code cannot exceed ${ITEM_LIMITS.hsnCode} characters`),
  /**
   * Coerces "18" -> 18 for form posts, but never coerces emptiness into a rate:
   * plain `z.coerce.number()` turns '', null and [] into 0, which is itself a valid
   * slab, so a blank field would silently be stored as 0% (exempt).
   */
  gstRate: z.preprocess(
    (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
    z
      .number({ required_error: 'GST % is required', invalid_type_error: 'GST % is required' })
      .refine((v) => (GST_RATES as readonly number[]).includes(v), `GST % must be one of ${GST_RATES.map((r) => `${r}%`).join(', ')}`),
  ),
  isActive: z.boolean().default(true),
});
export type ItemInput = z.infer<typeof itemSchema>;
