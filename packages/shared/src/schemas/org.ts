import { z } from 'zod';

export const companySchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  legalName: z.string().optional().nullable(),
  countryCode: z.string().min(2).default('IN'),
  taxId: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  currency: z.string().min(3).default('INR'),
  timeZone: z.string().min(1).default('Asia/Kolkata'),
  dateFormat: z.string().default('dd-MM-yyyy'),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(4),
  isActive: z.boolean().default(true),
  customFields: z.record(z.any()).default({}),
});
export type CompanyInput = z.infer<typeof companySchema>;

export const branchSchema = z.object({
  companyId: z.string().uuid('Company is required'),
  name: z.string().min(1, 'Branch name is required'),
  code: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});
export type BranchInput = z.infer<typeof branchSchema>;
