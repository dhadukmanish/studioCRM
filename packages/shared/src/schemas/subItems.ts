import { z } from 'zod';

/**
 * Sub Item Master — the products a studio actually bills, hanging off an Item Master row
 * (Photography → "Wedding Shoot" ₹2500). GST % and HSN belong to the parent Item and are
 * deliberately NOT repeated here: billing reads them through `itemId`.
 */
/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const SUB_ITEM_LIMITS = { productName: 120, remark: 500 } as const;
/** Ceiling of the `numeric(12, 2)` rate column — a larger value would be a database error, not a validation one. */
export const SUB_ITEM_RATE_MAX = 9999999999.99;

export const subItemSchema = z.object({
  /** The parent Item Master row. The API additionally proves it belongs to the caller's tenant. */
  itemId: z
    .string({ required_error: 'Item is required', invalid_type_error: 'Item is required' })
    .min(1, 'Item is required')
    .uuid('Select a valid item'),
  productName: z.string().trim().min(1, 'Product name is required').max(SUB_ITEM_LIMITS.productName, `Product name cannot exceed ${SUB_ITEM_LIMITS.productName} characters`),
  /**
   * Money. Coerces "500.50" -> 500.5 for form posts but never coerces emptiness into a rate:
   * plain `z.coerce.number()` turns '', null and [] into 0, and 0 is a legitimate rate, so a
   * blank field would silently be stored as free of charge.
   */
  rate: z.preprocess(
    (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
    z
      .number({ required_error: 'Rate is required', invalid_type_error: 'Rate is required' })
      .min(0, 'Rate cannot be negative')
      .max(SUB_ITEM_RATE_MAX, 'Rate is too large')
      // The column stores 2 decimals. Refuse a third rather than rounding it away behind the
      // user's back — a silently rounded price is a changed price.
      .refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), 'Rate can have at most 2 decimal places'),
  ),
  /** Free-form note ("Urgent", "Premium finish"). Blank is stored as NULL, never as ''. */
  remark: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null),
    z.string().trim().max(SUB_ITEM_LIMITS.remark, `Remark cannot exceed ${SUB_ITEM_LIMITS.remark} characters`).nullable(),
  ),
  isActive: z.boolean().default(true),
});
export type SubItemInput = z.infer<typeof subItemSchema>;
