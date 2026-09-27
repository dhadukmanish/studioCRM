import { eq, sql } from 'drizzle-orm';
import { DEFAULT_DATE_FORMAT, DEFAULT_PRINT_SETTINGS, DEFAULT_TIME_FORMAT, DEFAULT_WHATSAPP_INVOICE_MESSAGE, toPrintSettings, type PrintSettings } from '@erp/shared';
import { db, schema } from '../db/client';

/**
 * Tenant-wide APPLICATION settings. Add keys here; the UI (GeneralSettingsPage) reads/writes the
 * same object. Company identity (name, logo, address, GSTIN) is NOT here — it belongs to the
 * default company row (services/company.ts), so it is never stored twice. See docs/SETTINGS.md.
 */
export const DEFAULT_SETTINGS = {
  dateFormat: DEFAULT_DATE_FORMAT as string,
  timeFormat: DEFAULT_TIME_FORMAT as string,
  currency: 'INR',
  numberFormat: 'en-IN',
  themeMode: 'light',
  primaryColor: '#006CB8',
  allowSelfSignup: false,
  sessionHours: 12,
  passwordMinLength: 6,
  requireCompanyOnUsers: true,
  /** The WhatsApp invoice message, with {placeholders} (packages/shared/src/whatsapp.ts). */
  whatsappInvoiceMessage: DEFAULT_WHATSAPP_INVOICE_MESSAGE,
  /** The Book a new bill opens with when several are active; null = Automatic (last used). See resolveDefaultBook. */
  defaultBillingBookId: null as string | null,
  /** Print & Invoice settings (packages/shared/src/schemas/printSettings.ts) — always returned complete. */
  print: DEFAULT_PRINT_SETTINGS as PrintSettings,
};
export type AppSettings = typeof DEFAULT_SETTINGS & Record<string, any>;

export async function getSettings(tenantId: string): Promise<AppSettings> {
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.tenantId, tenantId));
  const stored = (row?.settings as any) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored, print: toPrintSettings(stored.print) };
}

/**
 * Writes ONLY the given top-level keys, merged into the stored JSON by the database itself
 * (`settings || patch`) — never a read-modify-write of the whole object. Two writers touching
 * different keys (a Print save and the template-seed marker, say) can never undo each other.
 */
export async function updateSettings(tenantId: string, patch: Record<string, any>) {
  await db
    .insert(schema.appSettings)
    .values({ tenantId, settings: patch })
    .onConflictDoUpdate({ target: schema.appSettings.tenantId, set: { settings: sql`coalesce(${schema.appSettings.settings}, '{}'::jsonb) || excluded.settings`, updatedAt: new Date() } });
  return getSettings(tenantId);
}
