import { z } from 'zod';

export const userSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Valid email is required'),
  username: z.string().min(3).optional().nullable().or(z.literal('')),
  mobile: z.string().optional().nullable(),
  password: z.string().min(6, 'Minimum 6 characters').optional(),
  roleId: z.string().uuid('Role is required'),
  companyIds: z.array(z.string().uuid()).default([]),
  branchIds: z.array(z.string().uuid()).default([]),
  /**
   * `permissionOverrides` is deliberately NOT accepted here. Permissions come from the role
   * alone; the column still exists and is still merged in plugins/auth.ts for rows seeded
   * before this decision, but nothing may set it through the API. See docs/ARCHITECTURE.md.
   */
  isActive: z.boolean().default(true),
  customFields: z.record(z.any()).default({}),
});
export type UserInput = z.infer<typeof userSchema>;

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6, 'Minimum 6 characters') });
export const profileSchema = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), mobile: z.string().optional().nullable(), avatarUrl: z.string().optional().nullable() });
