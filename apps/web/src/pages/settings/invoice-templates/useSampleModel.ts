import { useMemo } from 'react';
import { buildInvoiceModel, sampleInvoiceBill, sampleInvoicePayments, type InvoiceLayoutPreset, type InvoiceTaxMode, type InvoiceTemplateConfig, type InvoiceTemplateMode, type PrintSettings } from '@erp/shared';
import { useCompanyProfile, useDisplayFormats, usePrintSettings } from '@/lib/settings';

/**
 * A template drawn over the in-memory sample bill — the designer's live preview, the gallery
 * thumbnails and the Print & Invoice preview. Uses the real company profile, date format and Print
 * settings (or the unsaved draft of them, `print`), so what the studio sees is its own letterhead;
 * the bill is sample data and is never saved. The SAME builder and renderer as a real invoice.
 */
export function useSampleModel(
  template: { id?: string | null; templateName: string; supportedMode: InvoiceTemplateMode; layoutPreset: InvoiceLayoutPreset; config: InvoiceTemplateConfig },
  taxMode: InvoiceTaxMode,
  print?: PrintSettings,
) {
  const company = useCompanyProfile().data ?? null;
  const { dateFormat } = useDisplayFormats();
  const saved = usePrintSettings();
  const settings = print ?? saved;
  return useMemo(() => {
    const bill = sampleInvoiceBill(taxMode);
    return buildInvoiceModel({ bill, company, dateFormat, template: { id: template.id ?? null, ...template }, print: settings, payments: sampleInvoicePayments(bill), isSample: true });
  }, [template, taxMode, company, dateFormat, settings]);
}

/** The tax mode a template's sample shows by default: the one it supports, else With GST. */
export const sampleModeFor = (mode: InvoiceTemplateMode): InvoiceTaxMode => (mode === 'WITHOUT_GST' ? 'WITHOUT_GST' : 'WITH_GST');
