import { useQuery } from '@tanstack/react-query';
import type { InvoiceLayoutPreset, InvoiceRenderModel, InvoiceTemplateConfig, InvoiceTemplateMode } from '@erp/shared';
import { api, qs } from '@/lib/api';

/** A stored template as `/api/settings/invoice-templates` returns it. */
export interface InvoiceTemplateRecord {
  id: string;
  templateName: string;
  description: string | null;
  supportedMode: InvoiceTemplateMode;
  layoutPreset: InvoiceLayoutPreset;
  isDefault: boolean;
  isActive: boolean;
  config: InvoiceTemplateConfig;
  createdAt: string;
  updatedAt: string;
}
export interface InvoiceTemplateLookup { id: string; templateName: string; supportedMode: InvoiceTemplateMode; layoutPreset: InvoiceLayoutPreset; isDefault: boolean }

export const TEMPLATES_KEY = 'invoice-templates';

/** A saved bill's render model, plus the characters the PDF's Latin fonts cannot draw. */
export type BillInvoice = InvoiceRenderModel & { pdfUnprintable: string[] };

/** Template Master list (management). */
export const useInvoiceTemplates = () =>
  useQuery({ queryKey: [TEMPLATES_KEY, 'list'], queryFn: () => api.get<{ rows: InvoiceTemplateRecord[] }>('/api/settings/invoice-templates'), select: (d) => d.rows });

export const useInvoiceTemplate = (id?: string) =>
  useQuery({ queryKey: [TEMPLATES_KEY, 'one', id], queryFn: () => api.get<InvoiceTemplateRecord>(`/api/settings/invoice-templates/${id}`), enabled: !!id });

/** Active templates for the preview's picker — readable by anyone who may preview a bill. */
export const useInvoiceTemplateLookup = () =>
  useQuery({ queryKey: [TEMPLATES_KEY, 'lookup'], queryFn: () => api.get<InvoiceTemplateLookup[]>('/api/common/lookups/invoice-templates'), staleTime: 60_000 });

/**
 * A saved bill's invoice render model, built by the server from the bill's own snapshot. No
 * `templateId` means "the tenant's default for this bill"; choosing one previews it without
 * changing the default.
 */
export const useBillInvoice = (billId?: string, templateId?: string) =>
  useQuery({
    queryKey: ['bill-invoice', billId, templateId ?? ''],
    queryFn: () => api.get<BillInvoice>(`/api/bills/${billId}/invoice${qs({ templateId })}`),
    enabled: !!billId,
    // Always refetched on open: the preview must show the bill as saved NOW (and today's company
    // details), never a cached copy from before an edit — Print draws exactly this.
    staleTime: 0,
    placeholderData: (prev) => prev,
  });

/** Downloads the server-generated PDF — the authoritative document, not a screenshot of the preview. */
export async function downloadInvoicePdf(billId: string, fileName: string, templateId?: string) {
  const blob = await api.blob(`/api/bills/${billId}/invoice/pdf${qs({ templateId, download: 1 })}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
