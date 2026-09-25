import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Eye, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { INVOICE_LAYOUT_PRESET_LABELS, INVOICE_TEMPLATE_MODE_LABELS } from '@erp/shared';
import { Badge, ConfirmDialog, Dropdown, EmptyState, Modal, Spinner } from '@/components/ui';
import { InvoiceSheet } from '@/components/invoice/InvoiceDocument';
import { TEMPLATES_KEY, useInvoiceTemplates, type InvoiceTemplateRecord } from '@/lib/invoice';
import { useSave } from '@/lib/queries';
import { useCompanyLogo, useCompanyProfile } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { sampleModeFor, useSampleModel } from './useSampleModel';

const PERMISSION = 'settings_invoice_templates';
const INVALIDATE = [TEMPLATES_KEY, 'bill-invoice'];

/** One thumbnail: the real renderer over the sample bill, scaled down and cropped to the top of the page. */
function Thumbnail({ t, logoSrc }: { t: InvoiceTemplateRecord; logoSrc: string | null }) {
  const model = useSampleModel(t, sampleModeFor(t.supportedMode));
  return (
    <div className="pointer-events-none h-[232px] overflow-hidden rounded-t-lg border-b border-line bg-gray-100 px-3 pt-3" aria-hidden>
      <InvoiceSheet model={model} logoSrc={logoSrc} scale={0.27} />
    </div>
  );
}

function PreviewModal({ t, logoSrc, onClose }: { t: InvoiceTemplateRecord; logoSrc: string | null; onClose: () => void }) {
  const [mode, setMode] = useState(sampleModeFor(t.supportedMode));
  const model = useSampleModel(t, mode);
  return (
    <Modal open onClose={onClose} size="xl" title={`${t.templateName} — sample preview`} maxHeight="max-h-[92vh]">
      {t.supportedMode === 'BOTH' && (
        <div className="mb-3 inline-flex rounded-lg border border-line p-0.5 text-[13px]">
          {(['WITH_GST', 'WITHOUT_GST'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-md px-3 py-1 transition-colors duration-150 ${mode === m ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{m === 'WITH_GST' ? 'With GST' : 'Without GST'}</button>
          ))}
        </div>
      )}
      <div className="rounded-md bg-gray-100 p-4"><InvoiceSheet model={model} logoSrc={logoSrc} maxScale={0.95} /></div>
    </Modal>
  );
}

/**
 * Settings → Invoice Templates: a gallery, each card showing the template as it actually prints
 * (drawn by the invoice renderer over sample data — no PDF is generated for a thumbnail).
 */
export default function InvoiceTemplatesPage() {
  const nav = useNavigate();
  const q = useInvoiceTemplates();
  const can = useAuthStore((s) => s.can);
  const company = useCompanyProfile().data;
  const logoSrc = useCompanyLogo(company?.id, company?.logo?.version).data ?? null;
  const [preview, setPreview] = useState<InvoiceTemplateRecord | null>(null);
  const [del, setDel] = useState<InvoiceTemplateRecord | null>(null);
  const action = useSave({ invalidate: INVALIDATE });
  const remove = useSave({ invalidate: INVALIDATE, onSuccess: () => setDel(null) });
  const rows = q.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[20px] font-semibold text-gray-900">Invoice Templates</h2>
          <p className="text-[13px] text-gray-500">How a saved bill looks when it is previewed, printed or downloaded. Templates change presentation only — never a bill's figures.</p>
        </div>
        {can(PERMISSION, 'create') && (
          <button className="btn-primary" onClick={() => nav('/modules/settings/invoice-templates/new')}>
            <Plus className="h-4 w-4" /> Create Template
          </button>
        )}
      </div>

      {q.isLoading ? (
        <div className="py-10 text-center"><Spinner className="inline h-5 w-5" /></div>
      ) : !rows.length ? (
        <EmptyState title="No templates" />
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {rows.map((t) => (
            <div key={t.id} data-template-card={t.templateName} className={`rounded-lg border bg-white transition-colors duration-150 ${t.isDefault ? 'border-primary/60' : 'border-line hover:border-gray-300'}`}>
              <button type="button" className="block w-full text-left" onClick={() => setPreview(t)} aria-label={`Preview ${t.templateName}`}>
                <Thumbnail t={t} logoSrc={logoSrc} />
              </button>
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-gray-900" title={t.templateName}>{t.templateName}</div>
                    <div className="truncate text-[12px] text-gray-500">{INVOICE_LAYOUT_PRESET_LABELS[t.layoutPreset]} · {INVOICE_TEMPLATE_MODE_LABELS[t.supportedMode]}</div>
                  </div>
                  <Dropdown
                    trigger={<button type="button" className="row-action" aria-label={`Actions for ${t.templateName}`}><MoreHorizontal className="h-4 w-4" strokeWidth={1.5} /></button>}
                    items={[
                      { label: 'Preview', icon: <Eye className="h-3.5 w-3.5" />, onClick: () => setPreview(t) },
                      ...(can(PERMISSION, 'update') ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/settings/invoice-templates/${t.id}`) }] : []),
                      ...(can(PERMISSION, 'create') ? [{ label: 'Duplicate', icon: <Copy className="h-3.5 w-3.5" />, onClick: () => action.mutate({ method: 'post', url: `/api/settings/invoice-templates/${t.id}/duplicate` }) }] : []),
                      ...(can(PERMISSION, 'update') && !t.isDefault && t.isActive ? [{ label: 'Set as default', icon: <Star className="h-3.5 w-3.5" />, onClick: () => action.mutate({ method: 'post', url: `/api/settings/invoice-templates/${t.id}/default` }) }] : []),
                      ...(can(PERMISSION, 'delete') && !t.isDefault ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(t) }] : []),
                    ]}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.isDefault && <Badge color="blue">Default</Badge>}
                  {t.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && <PreviewModal t={preview} logoSrc={logoSrc} onClose={() => setPreview(null)} />}
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete template?"
        message={<>“{del?.templateName}” will be removed. Bills are not affected — a bill never depends on a template.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `/api/settings/invoice-templates/${del.id}` })}
      />
    </>
  );
}
