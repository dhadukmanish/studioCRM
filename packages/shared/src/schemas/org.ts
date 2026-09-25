import { z } from 'zod';
import { DATE_FORMATS, TIME_FORMATS } from '../dates.js';
import { WHATSAPP_MESSAGE_MAX, WHATSAPP_MESSAGE_VARIABLES, unknownMessageVariables } from '../whatsapp.js';

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

/** Company logo limits — the API enforces them (by the file's own bytes); the form uses them for a quick message. */
export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/**
 * GET /api/settings/company — the tenant's default company as the app brands itself with it
 * (and, later, an invoice's company block). Public letterhead details only, plus the logo's
 * version; never the image bytes. See docs/SETTINGS.md.
 */
export interface CompanyProfile {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  countryCode: string;
  currency: string;
  /** null when the company has no logo; `version` changes whenever the image does. */
  logo: { version: string; contentType: string } | null;
}

/**
 * PUT /api/settings body. Settings are a free-form tenant JSON object and other keys pass
 * through untouched, but the two every screen formats with are held to values the app can
 * render, so a bad save can never leave the whole UI printing raw dates.
 */
export const appSettingsSchema = z
  .object({
    dateFormat: z.enum(DATE_FORMATS, { errorMap: () => ({ message: `Date format must be one of ${DATE_FORMATS.join(', ')}` }) }).optional(),
    timeFormat: z.enum(TIME_FORMATS, { errorMap: () => ({ message: `Time format must be one of ${TIME_FORMATS.join(', ')}` }) }).optional(),
    /** The default WhatsApp invoice message (docs/WHATSAPP_SHARING.md). Only the known placeholders are allowed. */
    whatsappInvoiceMessage: z
      .string()
      .trim()
      .min(1, 'The WhatsApp message cannot be empty')
      .max(WHATSAPP_MESSAGE_MAX, `The WhatsApp message cannot exceed ${WHATSAPP_MESSAGE_MAX} characters`)
      .superRefine((v, ctx) => {
        const unknown = unknownMessageVariables(v);
        if (unknown.length) ctx.addIssue({ code: 'custom', message: `Unknown placeholder ${unknown.map((u) => `{${u}}`).join(', ')}. Use ${WHATSAPP_MESSAGE_VARIABLES.map((u) => `{${u}}`).join(', ')}` });
      })
      .optional(),
  })
  .passthrough();
