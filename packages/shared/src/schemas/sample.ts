import { z } from 'zod';

/** Sample master — copy this pattern for your own simple masters. */
export const categorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  code: z.string().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  customFields: z.record(z.any()).default({}),
});
export type CategoryInput = z.infer<typeof categorySchema>;
