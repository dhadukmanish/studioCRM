import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';

/** Tenant-wide defaults. Add keys here; the UI (GeneralSettingsPage) reads/writes the same object. */
export const DEFAULT_SETTINGS = {
  appName: 'ERP',
  dateFormat: 'dd-MM-yyyy',
  timeFormat: 'hh:mm tt',
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
