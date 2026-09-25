import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, Printer } from 'lucide-react';
import { INVOICE_TAX_MODE_LABELS, isTemplateCompatible } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { Badge, EmptyState, Select, Spinner } from '@/components/ui';
import { InvoicePrintRoot, InvoiceSheet, useInvoiceLogo } from '@/components/invoice/InvoiceDocument';
import { downloadInvoicePdf, useBillInvoice, useInvoiceTemplateLookup } from '@/lib/invoice';
import { ApiError } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * A saved bill's invoice. Read-only: it shows the server's render model of the bill, lets the
 * operator try another COMPATIBLE template (for this preview only — the tenant default is set in
 * Settings → Invoice Templates), print it, or download the server-generated PDF.
 */
export default function InvoicePreviewPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const invoice = useBillInvoice(id, templateId);
  const templates = useInvoiceTemplateLookup();
  const model = invoice.data;
  const logoSrc = useInvoiceLogo(model);
  const [downloading, setDownloading] = useState(false);
  // A chosen template can stop fitting (deactivated or edited since the picker loaded): fall back
  // to the default rather than leave the page stuck on an error with no picker.
  useEffect(() => {
    if (invoice.error && templateId) {
      toast.error(invoice.error instanceof ApiError ? invoice.error.message : 'That template cannot be used — showing the default');
      setTemplateId(undefined);
    }
  }, [invoice.error, templateId]);

  if (invoice.isLoading) return <div className="py-16 text-center"><Spinner className="inline h-5 w-5" /></div>;
  if (!model) {
    const msg = invoice.error instanceof ApiError ? invoice.error.message : 'The invoice could not be loaded.';
    return <EmptyState title="Invoice unavailable" description={msg} action={<button className="btn-outline" onClick={() => nav('/modules/billing')}>Back to bills</button>} />;
  }

  const options = (templates.data ?? []).filter((t) => isTemplateCompatible(t.supportedMode, model.taxMode)).map((t) => ({ value: t.id, label: `${t.templateName}${t.isDefault ? ' (default)' : ''}` }));
  const download = async () => {
    setDownloading(true);
    try {
      await downloadInvoicePdf(id!, model.fileName, templateId);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The PDF could not be generated');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Billing', href: '/modules/billing' }, { label: model.documentLabel.replace(' / ', '/'), href: `/modules/billing/${id}` }, { label: 'Invoice' }]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to bill" title="Back to bill" onClick={() => nav(`/modules/billing/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[20px] font-semibold text-gray-900">Invoice {model.documentLabel.replace(' / ', '/')}</h2>
        <Badge color={model.taxMode === 'WITH_GST' ? 'blue' : 'gray'}>{INVOICE_TAX_MODE_LABELS[model.taxMode]}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-gray-600">
            Template
            <Select
              size="sm"
              className="w-[220px]"
              value={templateId ?? model.template.id ?? ''}
              onChange={(v) => setTemplateId(v || undefined)}
              placeholder={model.template.id ? 'Default' : model.template.name}
              options={options}
            />
          </label>
          {invoice.isFetching && <Spinner />}
          <button type="button" className="btn-outline" disabled={invoice.isFetching} title={invoice.isFetching ? 'Loading the latest version of the bill…' : undefined} onClick={() => window.print()}>
            <Printer className="h-4 w-4" strokeWidth={1.5} /> Print
          </button>
          <button type="button" className="btn-primary" onClick={download} disabled={downloading}>
            {downloading ? <Spinner /> : <Download className="h-4 w-4" strokeWidth={1.5} />} Download PDF
          </button>
        </div>
      </div>
      {model.pdfUnprintable.length > 0 && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} />
          <span>
            The PDF cannot print these characters yet: <span className="font-medium">{model.pdfUnprintable.join(' ')}</span>. It supports English, Gujarati and
            Hindi text and ₹, so Download PDF will refuse this invoice. Print from this page instead, or change that text.
          </span>
        </div>
      )}
      <div className="rounded-lg border border-line bg-gray-100 px-3 py-5 sm:px-6">
        <InvoiceSheet model={model} logoSrc={logoSrc} maxScale={1.15} className="mx-auto max-w-[920px]" />
      </div>
      <p className="mt-2 text-center text-[12px] text-gray-500">The downloaded PDF is split into A4 pages, with the table header repeated on each page.</p>
      <InvoicePrintRoot model={model} logoSrc={logoSrc} />
    </>
  );
}
