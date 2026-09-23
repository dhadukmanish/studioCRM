import { z } from 'zod';
import { HEAD_GROUPS } from '../enums.js';

/**
 * Account Group Master — how a studio classifies its accounts (CASH, BANK, CUSTOMER, ...).
 * Each group is filed under one head group; Account Master will hang accounts off a group.
 * Classification only: nothing here posts or balances anything.
 */
/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const ACCOUNT_GROUP_LIMITS = { groupName: 120 } as const;

export const accountGroupSchema = z.object({
  groupName: z.string().trim().min(1, 'Account group name is required').max(ACCOUNT_GROUP_LIMITS.groupName, `Account group name cannot exceed ${ACCOUNT_GROUP_LIMITS.groupName} characters`),
  /**
   * A controlled choice, never free text. An unselected dropdown posts '', which is a missing
   * answer rather than a wrong one — so it is reported as "required", not as an invalid value.
   */
  headGroup: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(HEAD_GROUPS, {
      errorMap: (issue) => ({ message: issue.code === 'invalid_enum_value' ? `Type must be one of ${HEAD_GROUPS.join(', ')}` : 'Type is required' }),
    }),
  ),
  isActive: z.boolean().default(true),
});
export type AccountGroupInput = z.infer<typeof accountGroupSchema>;
