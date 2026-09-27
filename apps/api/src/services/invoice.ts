import { buildInvoiceModel, buildInvoiceShareContext, toDateFormat, type BillDiscountType, type InvoiceCopyLabel, type InvoiceImageRef, type InvoiceRenderModel, type InvoiceShareContext, type InvoiceTaxMode, type PrintAssetKind } from '@erp/shared';
import { getBill } from './bills';
import { getCompanyLogo, getCompanyProfile, getPrintAsset } from './company';
import { getSettings } from './settings';
import { resolveInvoiceTemplate } from './invoiceTemplates';
import { renderInvoicePdf, type InvoiceImage } from './invoicePdf';
import { paidPaiseByBill } from './billPayments';
import { db } from '../db/client';
import { AppError } from '../lib/errors';

/**
 * A saved bill's invoice — the ONE assembly path behind the preview, the PDF download, print, and
 * WhatsApp sharing (which downloads this same PDF). Read-only: it reads the bill's own snapshot, the company
 * profile, the tenant's settings (date format, Print & Invoice settings), a template and the bill's
 * derived payment position, and writes nothing.
 *
 *   saved bill ─┐
 *   payments ───┤
 *   company ────┼─> buildInvoiceModel (shared) ─> InvoiceRenderModel ─> browser preview
 *   settings ───┤                                                   └─> renderInvoicePdf
 *   template ───┘
 */
export async function getBillInvoice(tenantId: string, billId: string, templateId?: string, copyLabel?: InvoiceCopyLabel): Promise<{ model: InvoiceRenderModel; billUpdatedAt: Date }> {
  const [bill, company, settings] = await Promise.all([getBill(tenantId, billId), getCompanyProfile(tenantId), getSettings(tenantId)]);
  const template = await resolveInvoiceTemplate(tenantId, bill.taxMode as InvoiceTaxMode, templateId);
  // Paid is the one definition (services/billPayments.ts): allocations on ACTIVE receipts + ACTIVE
  // advance applications. Worked in paise, so Balance Due is exact. Read only when printed.
  let payments = null;
  if (template.config.totals.showPayments) {
    const paid = (await paidPaiseByBill(db, tenantId, [billId])).get(billId) ?? 0;
    const grand = Math.round(Number(bill.grandTotal) * 100);
    payments = { paid: paid / 100, outstanding: (grand - paid) / 100 };
  }
  const model = buildInvoiceModel({
    bill: { ...bill, taxMode: bill.taxMode as InvoiceTaxMode, discountType: bill.discountType as BillDiscountType },
    company,
    dateFormat: toDateFormat(settings.dateFormat),
    template,
    print: settings.print,
    payments,
    copyLabel,
  });
  return { model, billUpdatedAt: bill.updatedAt };
}

/**
 * What the WhatsApp Share dialog opens with (docs/WHATSAPP_SHARING.md): the bill's saved customer
 * and mobile, the stored Grand Total as the invoice prints it, the company name from Company
 * Settings, and the tenant's message with its placeholders filled. Read-only, tenant-scoped.
 * The PDF itself is NOT made here — the dialog fetches the very same PDF the Download button does.
 */
export async function getBillInvoiceShare(tenantId: string, billId: string): Promise<InvoiceShareContext> {
  const [bill, company, settings] = await Promise.all([getBill(tenantId, billId), getCompanyProfile(tenantId), getSettings(tenantId)]);
  return buildInvoiceShareContext({
    bill: { ...bill, taxMode: bill.taxMode as InvoiceTaxMode },
    company,
    dateFormat: toDateFormat(settings.dateFormat),
    messageTemplate: typeof settings.whatsappInvoiceMessage === 'string' ? settings.whatsappInvoiceMessage : null,
  });
}

/**
 * The template a share used, checked the way the PDF checks it: inside the tenant, active and
 * compatible with the bill (an explicitly chosen incompatible one is refused). Returns what the
 * audit entry may record — ids and names, no customer data.
 */
export async function resolveShareTemplate(tenantId: string, billId: string, templateId?: string) {
  const bill = await getBill(tenantId, billId);
  const template = await resolveInvoiceTemplate(tenantId, bill.taxMode as InvoiceTaxMode, templateId);
  return { documentLabel: `${bill.bookNumber}/${bill.billNumber}`, templateId: template.id, templateName: template.templateName };
}

/** A company image the model asks for, read inside the tenant — never through a URL. Gone meanwhile = no image. */
async function readImage(load: () => Promise<{ data: Buffer; contentType: string }>): Promise<InvoiceImage | null> {
  try {
    const r = await load();
    return { data: new Uint8Array(r.data), contentType: r.contentType };
  } catch (e) {
    if (e instanceof AppError && e.statusCode === 404) return null;
    throw e;
  }
}
const asset = (tenantId: string, kind: PrintAssetKind, ref: InvoiceImageRef | null) => (ref ? readImage(() => getPrintAsset(tenantId, kind, ref.companyId)) : Promise.resolve(null));

/** The invoice as PDF bytes plus its file name. Reusable by any delivery channel, not only a download. */
export async function getBillInvoicePdf(tenantId: string, billId: string, templateId?: string, copyLabel?: InvoiceCopyLabel): Promise<{ bytes: Uint8Array; fileName: string; model: InvoiceRenderModel }> {
  const { model, billUpdatedAt } = await getBillInvoice(tenantId, billId, templateId, copyLabel);
  const logoRef = model.header.logo;
  const [logo, signature, footer] = await Promise.all([
    logoRef ? readImage(() => getCompanyLogo(tenantId, logoRef.companyId)) : null,
    asset(tenantId, 'SIGNATURE', model.footer.signatureImage),
    asset(tenantId, 'FOOTER', model.footer.footerImage),
  ]);
  const bytes = await renderInvoicePdf(model, { logo, signature, footer }, { date: billUpdatedAt });
  return { bytes, fileName: model.fileName, model };
}
