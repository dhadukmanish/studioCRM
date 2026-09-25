import { eq } from 'drizzle-orm';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT } from '@erp/shared';
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
};
export type AppSettings = typeof DEFAULT_SETTINGS & Record<string, any>;

export async function getSettings(tenantId: string): Promise<AppSettings> {
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.tenantId, tenantId));
  return { ...DEFAULT_SETTINGS, ...((row?.settings as any) ?? {}) };
}

export async function updateSettings(tenantId: string, patch: Record<string, any>) {
  const next = { ...(await getSettings(tenantId)), ...patch };
  await db.insert(schema.appSettings).values({ tenantId, settings: next }).onConflictDoUpdate({ target: schema.appSettings.tenantId, set: { settings: next, updatedAt: new Date() } });
  return next;
}
