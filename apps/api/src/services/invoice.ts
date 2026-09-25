import { buildInvoiceModel, toDateFormat, type BillDiscountType, type InvoiceRenderModel, type InvoiceTaxMode } from '@erp/shared';
import { getBill } from './bills';
import { getCompanyLogo, getCompanyProfile } from './company';
import { getSettings } from './settings';
import { resolveInvoiceTemplate } from './invoiceTemplates';
import { renderInvoicePdf, type InvoiceLogo } from './invoicePdf';
import { AppError } from '../lib/errors';

/**
 * A saved bill's invoice — the ONE assembly path behind the preview, the PDF download, print, and
 * (next phase) WhatsApp sharing. Read-only: it reads the bill's own snapshot, the company
 * profile, the tenant's date format and a template, and writes nothing.
 *
 *   saved bill ─┐
 *   company ────┼─> buildInvoiceModel (shared) ─> InvoiceRenderModel ─> browser preview
 *   settings ───┤                                                   └─> renderInvoicePdf
 *   template ───┘
 */
export async function getBillInvoice(tenantId: string, billId: string, templateId?: string): Promise<{ model: InvoiceRenderModel; billUpdatedAt: Date }> {
  const [bill, company, settings] = await Promise.all([getBill(tenantId, billId), getCompanyProfile(tenantId), getSettings(tenantId)]);
  const template = await resolveInvoiceTemplate(tenantId, bill.taxMode as InvoiceTaxMode, templateId);
  const model = buildInvoiceModel({
    bill: { ...bill, taxMode: bill.taxMode as InvoiceTaxMode, discountType: bill.discountType as BillDiscountType },
    company,
    dateFormat: toDateFormat(settings.dateFormat),
    template,
  });
  return { model, billUpdatedAt: bill.updatedAt };
}

/** The invoice as PDF bytes plus its file name. Reusable by any delivery channel, not only a download. */
export async function getBillInvoicePdf(tenantId: string, billId: string, templateId?: string): Promise<{ bytes: Uint8Array; fileName: string; model: InvoiceRenderModel }> {
  const { model, billUpdatedAt } = await getBillInvoice(tenantId, billId, templateId);
  let logo: InvoiceLogo | null = null;
  if (model.header.logo) {
    // Read inside the caller's tenant through the Phase 3 logo service — never through a URL.
    try {
      const l = await getCompanyLogo(tenantId, model.header.logo.companyId);
      logo = { data: new Uint8Array(l.data), contentType: l.contentType };
    } catch (e) {
      // A logo removed between the two reads is simply no logo.
      if (!(e instanceof AppError && e.statusCode === 404)) throw e;
    }
  }
  const bytes = await renderInvoicePdf(model, logo, { date: billUpdatedAt });
  return { bytes, fileName: model.fileName, model };
}
