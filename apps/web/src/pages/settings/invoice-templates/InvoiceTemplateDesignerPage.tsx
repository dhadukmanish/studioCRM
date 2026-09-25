import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Save } from 'lucide-react';
import {
  INVOICE_ALIGNMENTS,
  INVOICE_COLUMN_LABELS,
  INVOICE_COLUMNS,
  INVOICE_LAYOUT_PRESETS,
  INVOICE_LAYOUT_PRESET_LABELS,
  INVOICE_TEMPLATE_LIMITS,
  INVOICE_TEMPLATE_MODES,
  INVOICE_TEMPLATE_MODE_LABELS,
  invoiceTemplateSchema,
  starterInvoiceTemplates,
  type InvoiceColumn,
  type InvoiceTaxMode,
  type InvoiceTemplateConfig,
  type InvoiceTemplateInput,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { Checkbox, EmptyState, Field, Select, Spinner, Switch, TextArea, TextInput } from '@/components/ui';
import { InvoiceSheet } from '@/components/invoice/InvoiceDocument';
import { TEMPLATES_KEY, useInvoiceTemplate, type InvoiceTemplateRecord } from '@/lib/invoice';
import { useSave } from '@/lib/queries';
import { useCompanyLogo, useCompanyProfile } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { toast } from '@/lib/toast';
import { sampleModeFor, useSampleModel } from './useSampleModel';

type Draft = Omit<InvoiceTemplateInput, 'description'> & { description: string };
type Section = 'header' | 'customer' | 'columns' | 'totals' | 'footer' | 'page';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'header', label: 'Header' },
  { value: 'customer', label: 'Customer' },
  { value: 'columns', label: 'Columns' },
  { value: 'totals', label: 'Totals' },
  { value: 'footer', label: 'Footer' },
  { value: 'page', label: 'Page' },
];
const ALIGN_OPTIONS = INVOICE_ALIGNMENTS.map((a) => ({ value: a, label: a[0] + a.slice(1).toLowerCase() }));

const fromStarter = (): Draft => {
  const s = starterInvoiceTemplates()[0];
  return { templateName: '', description: '', supportedMode: s.supportedMode, layoutPreset: s.layoutPreset, isActive: true, config: s.config };
};
const fromRecord = (t: InvoiceTemplateRecord): Draft => ({ templateName: t.templateName, description: t.description ?? '', supportedMode: t.supportedMode, layoutPreset: t.layoutPreset, isActive: t.isActive, config: t.config });

/**
 * Create / edit an invoice template: a controlled configuration panel on the left, the live A4
 * preview (sample bill, real letterhead) on the right. Only the schema's switches, choices and
 * plain-text fields exist — there is no free positioning, HTML or CSS.
 */
export default function InvoiceTemplateDesignerPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const record = useInvoiceTemplate(isNew ? undefined : id);
  const can = useAuthStore((s) => s.can)('settings_invoice_templates', isNew ? 'create' : 'update');
  const [draft, setDraft] = useState<Draft | null>(isNew ? fromStarter() : null);
  useEffect(() => { if (!isNew && record.data) setDraft(fromRecord(record.data)); }, [isNew, record.data]);

  if (!isNew && record.isLoading) return <div className="py-16 text-center"><Spinner className="inline h-5 w-5" /></div>;
  if (!draft) return <EmptyState title="Template not found" action={<button className="btn-outline" onClick={() => nav('/modules/settings/invoice-templates')}>Back to templates</button>} />;
  return <Designer key={id ?? 'new'} id={isNew ? undefined : id} draft={draft} setDraft={setDraft} canSave={can} isDefault={!!record.data?.isDefault} />;
}

function Designer({ id, draft, setDraft, canSave, isDefault }: { id?: string; draft: Draft; setDraft: (d: Draft) => void; canSave: boolean; isDefault: boolean }) {
  const nav = useNavigate();
  const [section, setSection] = useState<Section>('header');
  const [sampleMode, setSampleMode] = useState<InvoiceTaxMode>(sampleModeFor(draft.supportedMode));
  const company = useCompanyProfile().data;
  const logoSrc = useCompanyLogo(company?.id, company?.logo?.version).data ?? null;
  const cfg = draft.config;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setCfg = <K extends keyof InvoiceTemplateConfig>(key: K, patch: Partial<InvoiceTemplateConfig[K]>) => set({ config: { ...cfg, [key]: { ...(cfg[key] as object), ...patch } } });

  // A sample in a mode the template cannot print would be a misleading preview.
  const effectiveMode: InvoiceTaxMode = draft.supportedMode === 'BOTH' ? sampleMode : draft.supportedMode;
  const previewTemplate = useMemo(() => ({ id: id ?? null, templateName: draft.templateName || 'Untitled', supportedMode: draft.supportedMode, layoutPreset: draft.layoutPreset, config: cfg }), [id, draft.templateName, draft.supportedMode, draft.layoutPreset, cfg]);
  const model = useSampleModel(previewTemplate, effectiveMode);

  const save = useSave({ invalidate: [TEMPLATES_KEY, 'bill-invoice'], onSuccess: () => nav('/modules/settings/invoice-templates') });
  const submit = () => {
    const parsed = invoiceTemplateSchema.safeParse({ ...draft, description: draft.description || null });
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message ?? 'Check the template settings');
    save.mutate({ method: id ? 'put' : 'post', url: id ? `/api/settings/invoice-templates/${id}` : '/api/settings/invoice-templates', body: parsed.data });
  };

  return (
    <div
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (canSave) submit();
        }
      }}
    >
      <Crumb items={[{ label: 'Settings', href: '/modules/settings' }, { label: 'Invoice Templates', href: '/modules/settings/invoice-templates' }, { label: id ? 'Edit' : 'New' }]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to templates" title="Back to templates" onClick={() => nav('/modules/settings/invoice-templates')}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <TextInput
          aria-label="Template name"
          placeholder="Template name"
          value={draft.templateName}
          maxLength={INVOICE_TEMPLATE_LIMITS.templateName}
          onChange={(e) => set({ templateName: e.target.value })}
          className="w-[260px] font-medium"
          autoFocus={!id}
        />
        <Select className="w-[190px]" value={draft.supportedMode} placeholder="" onChange={(v) => set({ supportedMode: v as Draft['supportedMode'] })} options={INVOICE_TEMPLATE_MODES.map((m) => ({ value: m, label: INVOICE_TEMPLATE_MODE_LABELS[m] }))} />
        <Select className="w-[140px]" value={draft.layoutPreset} placeholder="" onChange={(v) => set({ layoutPreset: v as Draft['layoutPreset'] })} options={INVOICE_LAYOUT_PRESETS.map((p) => ({ value: p, label: INVOICE_LAYOUT_PRESET_LABELS[p] }))} />
        <span title={isDefault ? 'The default template cannot be made inactive' : undefined}>
          <Switch checked={draft.isActive} onChange={(v) => set({ isActive: v })} label="Active" disabled={isDefault} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn-outline" onClick={() => nav('/modules/settings/invoice-templates')}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!canSave || save.isPending} onClick={submit}>
            {save.isPending ? <Spinner /> : <Save className="h-4 w-4" strokeWidth={1.5} />} Save
          </button>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="card p-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
          <div role="tablist" aria-label="Template sections" className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-gray-50 p-1">
            {SECTIONS.map((sec) => (
              <button key={sec.value} type="button" role="tab" aria-selected={section === sec.value} onClick={() => setSection(sec.value)} className={`rounded-md px-2 py-1 text-[13px] transition-colors duration-150 ${section === sec.value ? "bg-white font-medium text-primary shadow-sm" : "text-gray-600 hover:text-gray-900"}`}>
                {sec.label}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {section === 'header' && (
              <>
                <Field label="Invoice title (with GST)"><TextInput size="sm" value={cfg.header.title} maxLength={INVOICE_TEMPLATE_LIMITS.title} onChange={(e) => setCfg('header', { title: e.target.value })} /></Field>
                <Field label="Invoice title (without GST)" hint="Kept separate so a bill that charged no tax is never headed “Tax Invoice”.">
                  <TextInput size="sm" value={cfg.header.titleWithoutGst} maxLength={INVOICE_TEMPLATE_LIMITS.title} onChange={(e) => setCfg('header', { titleWithoutGst: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Header alignment"><Select size="sm" value={cfg.header.alignment} placeholder="" onChange={(v) => setCfg('header', { alignment: v as never })} options={ALIGN_OPTIONS} /></Field>
                  <Field label="Logo alignment"><Select size="sm" value={cfg.header.logoAlignment} placeholder="" onChange={(v) => setCfg('header', { logoAlignment: v as never })} options={ALIGN_OPTIONS} /></Field>
                </div>
                <Toggles>
                  <Switch checked={cfg.header.showLogo} onChange={(v) => setCfg('header', { showLogo: v })} label="Company logo" />
                  <Switch checked={cfg.header.showCompanyName} onChange={(v) => setCfg('header', { showCompanyName: v })} label="Company name" />
                  <Switch checked={cfg.header.showCompanyAddress} onChange={(v) => setCfg('header', { showCompanyAddress: v })} label="Address" />
                  <Switch checked={cfg.header.showCompanyPhone} onChange={(v) => setCfg('header', { showCompanyPhone: v })} label="Phone" />
                  <Switch checked={cfg.header.showCompanyEmail} onChange={(v) => setCfg('header', { showCompanyEmail: v })} label="Email" />
                  <Switch checked={cfg.header.showCompanyGstin} onChange={(v) => setCfg('header', { showCompanyGstin: v })} label="GSTIN" />
                </Toggles>
                <Note>Name, logo, address, phone, email and GSTIN come from Settings → Companies. Only details the company has are printed.</Note>
              </>
            )}
            {section === 'customer' && (
              <>
                <Note>Bill No., Book, Bill Date and Customer name always print — they identify the invoice.</Note>
                <Toggles>
                  <Switch checked={cfg.customer.showMobile} onChange={(v) => setCfg('customer', { showMobile: v })} label="Mobile" />
                  <Switch checked={cfg.customer.showBabyName} onChange={(v) => setCfg('customer', { showBabyName: v })} label="Baby name" />
                  <Switch checked={cfg.customer.showBirthDate} onChange={(v) => setCfg('customer', { showBirthDate: v })} label="Birth date" />
                  <Switch checked={cfg.customer.showDeliveryDate} onChange={(v) => setCfg('customer', { showDeliveryDate: v })} label="Delivery date" />
                  <Switch checked={cfg.customer.showAppointmentReference} onChange={(v) => setCfg('customer', { showAppointmentReference: v })} label="Appointment no." />
                  <Switch checked={cfg.customer.showRemark} onChange={(v) => setCfg('customer', { showRemark: v })} label="Bill remark" />
                </Toggles>
              </>
            )}
            {section === 'columns' && <ColumnsEditor columns={cfg.columns} onChange={(columns) => set({ config: { ...cfg, columns } })} />}
            {section === 'totals' && (
              <>
                <Note>Grand Total always prints. Figures are the bill’s own — the template only chooses which lines show.</Note>
                <Toggles cols={1}>
                  <Switch checked={cfg.totals.showSubTotal} onChange={(v) => setCfg('totals', { showSubTotal: v })} label="Sub Total" />
                  <Switch checked={cfg.totals.showDiscount} onChange={(v) => setCfg('totals', { showDiscount: v })} label="Discount (when the bill has one)" />
                  <Switch checked={cfg.totals.showTaxableTotal} onChange={(v) => setCfg('totals', { showTaxableTotal: v })} label="Taxable Amount (GST bills)" />
                  <Switch checked={cfg.totals.showGstTotal} onChange={(v) => setCfg('totals', { showGstTotal: v })} label="GST (GST bills)" />
                  <Switch checked={cfg.totals.showGstSummary} onChange={(v) => setCfg('totals', { showGstSummary: v })} label="Rate-wise GST summary (GST bills)" />
                </Toggles>
              </>
            )}
            {section === 'footer' && (
              <>
                <Switch checked={cfg.footer.showTerms} onChange={(v) => setCfg('footer', { showTerms: v })} label="Terms & conditions" />
                <Field label="Terms" hint={`Plain text, up to ${INVOICE_TEMPLATE_LIMITS.terms} characters.`}>
                  <TextArea value={cfg.footer.terms} maxLength={INVOICE_TEMPLATE_LIMITS.terms} disabled={!cfg.footer.showTerms} onChange={(e) => setCfg('footer', { terms: e.target.value })} className="min-h-[90px] text-[13px]" />
                </Field>
                <Switch checked={cfg.footer.showThankYou} onChange={(v) => setCfg('footer', { showThankYou: v })} label="Thank-you note" />
                <TextInput size="sm" aria-label="Thank-you note" value={cfg.footer.thankYou} maxLength={INVOICE_TEMPLATE_LIMITS.thankYou} disabled={!cfg.footer.showThankYou} onChange={(e) => setCfg('footer', { thankYou: e.target.value })} />
                <Switch checked={cfg.footer.showSignatory} onChange={(v) => setCfg('footer', { showSignatory: v })} label="Authorised signatory" />
              </>
            )}
            {section === 'page' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Paper"><Select size="sm" value="A4" placeholder="" disabled onChange={() => undefined} options={[{ value: 'A4', label: 'A4' }]} /></Field>
                  <Field label="Orientation"><Select size="sm" value="PORTRAIT" placeholder="" disabled onChange={() => undefined} options={[{ value: 'PORTRAIT', label: 'Portrait' }]} /></Field>
                  <Field label="Margins"><Select size="sm" value={cfg.page.margins} placeholder="" onChange={(v) => setCfg('page', { margins: v as never })} options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'NARROW', label: 'Narrow' }]} /></Field>
                  <Field label="Spacing"><Select size="sm" value={cfg.page.density} placeholder="" onChange={(v) => setCfg('page', { density: v as never })} options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'COMPACT', label: 'Compact' }]} /></Field>
                </div>
                <Field label="Description"><TextArea value={draft.description} maxLength={INVOICE_TEMPLATE_LIMITS.description} onChange={(e) => set({ description: e.target.value })} className="min-h-[60px] text-[13px]" placeholder="Internal note (optional)" /></Field>
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-line bg-gray-100 p-3 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-gray-500">Live preview · sample bill, not saved</span>
            <div className="inline-flex rounded-lg border border-line bg-white p-0.5 text-[12.5px]">
              {(['WITH_GST', 'WITHOUT_GST'] as const).map((m) => {
                const allowed = draft.supportedMode === 'BOTH' || draft.supportedMode === m;
                return (
                  <button key={m} type="button" disabled={!allowed} onClick={() => setSampleMode(m)} className={`rounded-md px-3 py-1 transition-colors duration-150 disabled:opacity-40 ${effectiveMode === m ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
                    {m === 'WITH_GST' ? 'With GST' : 'Without GST'}
                  </button>
                );
              })}
            </div>
          </div>
          <InvoiceSheet model={model} logoSrc={logoSrc} maxScale={1} className="mx-auto max-w-[860px]" />
        </div>
      </div>
    </div>
  );
}

/** Switches in an aligned grid — two columns for short labels, one for long ones. */
const Toggles = ({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 }) => <div className={`grid gap-x-4 gap-y-2.5 ${cols === 2 ? "grid-cols-2" : "grid-cols-1"} [&>*]:min-w-0`}>{children}</div>;
const Note = ({ children }: { children: ReactNode }) => <p className="text-[12px] leading-snug text-gray-500">{children}</p>;

/** Show/hide and order the printed columns. Visible columns first, in print order. */
function ColumnsEditor({ columns, onChange }: { columns: InvoiceColumn[]; onChange: (c: InvoiceColumn[]) => void }) {
  const hidden = INVOICE_COLUMNS.filter((c) => !columns.includes(c));
  const move = (i: number, d: -1 | 1) => {
    const next = [...columns];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const required = (c: InvoiceColumn) => c === 'total' || ((c === 'item' || c === 'product') && columns.filter((x) => x === 'item' || x === 'product').length === 1 && columns.includes(c));
  return (
    <div>
      <Note>GST %, GST and Taxable are left out automatically on a bill without GST.</Note>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {columns.map((c, i) => (
          <li key={c} className="flex items-center gap-2 px-2 py-1.5">
            <Checkbox checked disabled={required(c)} onChange={() => onChange(columns.filter((x) => x !== c))} label={INVOICE_COLUMN_LABELS[c] === '#' ? 'Serial no. (#)' : INVOICE_COLUMN_LABELS[c]} className="flex-1 text-[13px]" />
            <button type="button" className="row-action" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${INVOICE_COLUMN_LABELS[c]} left`}><ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} /></button>
            <button type="button" className="row-action" disabled={i === columns.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${INVOICE_COLUMN_LABELS[c]} right`}><ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} /></button>
          </li>
        ))}
        {hidden.map((c) => (
          <li key={c} className="flex items-center gap-2 px-2 py-1.5">
            <Checkbox checked={false} onChange={() => onChange([...columns, c])} label={INVOICE_COLUMN_LABELS[c] === '#' ? 'Serial no. (#)' : INVOICE_COLUMN_LABELS[c]} className="flex-1 text-[13px] text-gray-500" />
          </li>
        ))}
      </ul>
    </div>
  );
}
