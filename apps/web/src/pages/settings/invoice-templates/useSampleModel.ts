import { useMemo } from 'react';
import { buildInvoiceModel, sampleInvoiceBill, type InvoiceLayoutPreset, type InvoiceTaxMode, type InvoiceTemplateConfig, type InvoiceTemplateMode } from '@erp/shared';
import { useCompanyProfile, useDisplayFormats } from '@/lib/settings';

/**
 * A template drawn over the in-memory sample bill — the designer's live preview and the
 * gallery thumbnails. Uses the real company profile and date format, so what the studio sees is
 * its own letterhead; the bill is sample data and is never saved.
 */
export function useSampleModel(
  template: { id?: string | null; templateName: string; supportedMode: InvoiceTemplateMode; layoutPreset: InvoiceLayoutPreset; config: InvoiceTemplateConfig },
  taxMode: InvoiceTaxMode,
) {
  const company = useCompanyProfile().data ?? null;
  const { dateFormat } = useDisplayFormats();
  return useMemo(
    () => buildInvoiceModel({ bill: sampleInvoiceBill(taxMode), company, dateFormat, template: { id: template.id ?? null, ...template }, isSample: true }),
    [template, taxMode, company, dateFormat],
  );
}

/** The tax mode a template's sample shows by default: the one it supports, else With GST. */
export const sampleModeFor = (mode: InvoiceTemplateMode): InvoiceTaxMode => (mode === 'WITHOUT_GST' ? 'WITHOUT_GST' : 'WITH_GST');
