import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { DEFAULT_TIME_ZONE, LOGO_MAX_BYTES, todayInTimeZone, type CompanyProfile, type LogoContentType } from '@erp/shared';
import { notFound, validation } from '../lib/errors';

export { LOGO_MAX_BYTES };

/*
 * The tenant's company profile — the read model behind the app's branding (sidebar name and
 * logo) and, later, the company block of an invoice. It is always the tenant's DEFAULT company,
 * resolved from the caller's token, never from an id the client sends. The shape
 * (`CompanyProfile`) lives in @erp/shared so the web app reads the same type.
 */

const c = schema.companies;
const l = schema.companyLogos;

export async function getCompanyProfile(tenantId: string): Promise<CompanyProfile | null> {
  const [row] = await db
    .select({
      id: c.id, name: c.name, legalName: c.legalName, taxId: c.taxId, email: c.email, phone: c.phone, website: c.website,
      addressLine1: c.addressLine1, addressLine2: c.addressLine2, city: c.city, state: c.state, pincode: c.pincode,
      countryCode: c.countryCode, currency: c.currency, logoUpdatedAt: l.updatedAt, logoContentType: l.contentType,
    })
    .from(c)
    .leftJoin(l, and(eq(l.companyId, c.id), eq(l.tenantId, c.tenantId)))
    .where(eq(c.tenantId, tenantId))
    .orderBy(desc(c.isDefault), asc(c.createdAt))
    .limit(1);
  if (!row) return null;
  const { logoUpdatedAt, logoContentType, ...company } = row;
  return { ...company, logo: logoUpdatedAt && logoContentType ? { version: logoVersion(logoUpdatedAt), contentType: logoContentType } : null };
}

/** The cache key a logo URL carries: it changes whenever the image is replaced. */
export const logoVersion = (updatedAt: Date) => String(updatedAt.getTime());

/**
 * The image type from the file's own leading bytes — the declared mimetype and the file name
 * are the client's claim and are not trusted. PNG, JPEG and WebP only: SVG is refused because
 * it can carry script, and nothing here needs a vector logo.
 */
export function sniffLogoType(buf: Buffer): LogoContentType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function requireCompany(tenantId: string, companyId: string) {
  const [row] = await db.select({ id: c.id, name: c.name }).from(c).where(and(eq(c.id, companyId), eq(c.tenantId, tenantId)));
  if (!row) throw notFound('Company');
  return row;
}

export async function getCompanyLogo(tenantId: string, companyId: string) {
  const [row] = await db.select({ contentType: l.contentType, data: l.data, updatedAt: l.updatedAt }).from(l).where(and(eq(l.companyId, companyId), eq(l.tenantId, tenantId)));
  if (!row) throw notFound('Company logo');
  return row;
}

/** Stores (or replaces) a company's logo after checking the bytes really are a supported image. */
export async function saveCompanyLogo(tenantId: string, companyId: string, data: Buffer) {
  const company = await requireCompany(tenantId, companyId);
  if (!data.length) throw validation('The logo file is empty');
  if (data.length > LOGO_MAX_BYTES) throw validation('The logo must be 1 MB or smaller');
  const contentType = sniffLogoType(data);
  if (!contentType) throw validation('The logo must be a PNG, JPEG or WebP image');
  const now = new Date();
  await db
    .insert(l)
    .values({ companyId, tenantId, contentType, byteSize: data.length, data, updatedAt: now })
    .onConflictDoUpdate({ target: l.companyId, set: { contentType, byteSize: data.length, data, updatedAt: now } });
  return { company, logo: { version: logoVersion(now), contentType } };
}

export async function deleteCompanyLogo(tenantId: string, companyId: string) {
  const company = await requireCompany(tenantId, companyId);
  await db.delete(l).where(and(eq(l.companyId, companyId), eq(l.tenantId, tenantId)));
  return company;
}

/** Today's business date for the tenant: the default company's time zone decides, never the server's or a browser's. */
export async function businessToday(tenantId: string): Promise<string> {
  const [company] = await db.select({ timeZone: c.timeZone }).from(c).where(eq(c.tenantId, tenantId)).orderBy(desc(c.isDefault), asc(c.createdAt)).limit(1);
  return todayInTimeZone(company?.timeZone ?? DEFAULT_TIME_ZONE);
}
