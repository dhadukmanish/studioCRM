import { z } from 'zod';

export const roleSchema = z.object({
  name: z.string().min(1, 'Role name is required'),
  description: z.string().optional().nullable(),
  permissions: z.record(z.array(z.enum(['read', 'create', 'update', 'delete']))).default({}),
  isActive: z.boolean().default(true),
});
export type RoleInput = z.infer<typeof roleSchema>;
