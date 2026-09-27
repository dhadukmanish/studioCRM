import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, RotateCcw, Save, Star } from 'lucide-react';
import {
  INVOICE_ACCENTS,
  INVOICE_ACCENT_COLORS,
  INVOICE_ACCENT_LABELS,
  INVOICE_COPY_LABELS,
  INVOICE_COPY_LABEL_TEXT,
  PRINT_SETTINGS_LIMITS,
  printSettingsSchema,
  type InvoiceTaxMode,
  type PrintSettings,
} from '@erp/shared';
import { Field, Modal, Select, Spinner, Switch, TextArea, TextInput } from '@/components/ui';
import { InvoiceSheet, useCompanyImages } from '@/components/invoice/InvoiceDocument';
import { TEMPLATES_KEY, useInvoiceTemplates, type InvoiceTemplateRecord } from '@/lib/invoice';
import { useSave, useSettings } from '@/lib/queries';
import { useCompanyProfile, usePrintSettings } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { toast } from '@/lib/toast';
import { cx } from '@/lib/format';
import { CompanyLogoField } from '../CompanyLogoField';
import { sampleModeFor, useSampleModel } from '../invoice-templates/useSampleModel';
import { PrintAssetField } from './PrintAssetField';

type Tab = 'branding' | 'document' | 'payment' | 'templates';
const TABS: { value: Tab; label: string }[] = [
  { value: 'branding', label: 'Branding' },
  { value: 'document', label: 'Document' },
  { value: 'payment', label: 'Payment' },
  { value: 'templates', label: 'Templates' },
];
const PERMISSION = 'settings_invoice_templates';

/**
 * Settings → Print & Invoice. What every invoice prints besides the bill itself: branding images,
 * the copy label and accent, bank details, note, terms and footer — beside a live preview drawn by
 * the SAME renderer as a real invoice, over the sample bill (never saved). Images save on their own
 * endpoint at once (like the logo); everything else is a draft until Save. See docs/INVOICE_TEMPLATES.md.
 */
export default function PrintSettingsPage() {
  const saved = usePrintSettings();
  // Until the tenant's settings have loaded, `saved` is only the defaults: nothing may be saved
  // from that state, or a Save would overwrite the real settings with defaults.
  const loaded = useSettings().isSuccess;
  const [draft, setDraft] = useState<PrintSettings>(saved);
  const [tab, setTab] = useState<Tab>('branding');
  const [mobilePreview, setMobilePreview] = useState(false);
  const can = useAuthStore((s) => s.can);
  const canEdit = can(PERMISSION, 'update') && loaded;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  // When the saved settings change (first load, a save, another tab's save) the draft follows them
  // — unless the operator has edited it since the last saved version it was based on.
  const savedKey = JSON.stringify(saved);
  const base = useRef(savedKey);
  useEffect(() => {
    // Captured now: React runs the updater later, after the ref below already holds the new value.
    const previous = base.current;
    base.current = savedKey;
    setDraft((d) => (JSON.stringify(d) === previous ? saved : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const templates = useInvoiceTemplates();
  const active = (templates.data ?? []).filter((t) => t.isActive);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewTemplate = active.find((t) => t.id === previewId) ?? active.find((t) => t.layoutPreset === 'STUDIO') ?? active.find((t) => t.isDefault) ?? active[0];

  const save = useSave<PrintSettings>({ invalidate: ['settings', 'bill-invoice'] });
  const submit = () => {
    const parsed = printSettingsSchema.safeParse(draft);
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message ?? 'Check the print settings');
    save.mutate({ method: 'put', url: '/api/settings/print', body: parsed.data });
  };
  const set = (patch: Partial<PrintSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const preview = previewTemplate ? <Preview template={previewTemplate} print={draft} onPick={setPreviewId} templates={active} /> : <div className="py-10 text-center"><Spinner className="inline h-5 w-5" /></div>;

  return (
    <div
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (canEdit && dirty) submit();
        }
      }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold text-gray-900">Print &amp; Invoice</h2>
          <p className="text-[12.5px] text-gray-500">What every invoice prints besides the bill — used by Preview, Print, PDF and the WhatsApp invoice link.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <button type="button" className="btn-ghost" onClick={() => setDraft(saved)}>
              <RotateCcw className="h-4 w-4" strokeWidth={1.5} /> Discard
            </button>
          )}
          <button type="button" className="btn-primary" disabled={!canEdit || !dirty || save.isPending} onClick={submit}>
            {save.isPending ? <Spinner /> : <Save className="h-4 w-4" strokeWidth={1.5} />} Save
          </button>
        </div>
      </div>

      <div className="grid items-start gap-4 min-[1400px]:grid-cols-[400px_minmax(0,1fr)]">
        <div className="card min-w-0 p-3 sm:p-4">
          {/* Compact segmented sections, as in the template designer — all four always visible, no scrolling tab strip. */}
          <div role="tablist" aria-label="Print settings sections" className="mb-4 grid grid-cols-4 gap-1 rounded-lg bg-gray-50 p-1">
            {TABS.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={cx('rounded-md px-1 py-1 text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', tab === t.value ? 'bg-surface font-medium text-primary shadow-sm' : 'text-gray-600 hover:text-gray-900')}>
                {t.label}
              </button>
            ))}
          </div>
          <fieldset disabled={!canEdit} className="space-y-4">
            {tab === 'branding' && <Branding draft={draft} set={set} canEdit={canEdit} />}
            {tab === 'document' && <DocumentTab draft={draft} set={set} />}
            {tab === 'payment' && <PaymentTab draft={draft} set={set} />}
            {tab === 'templates' && <TemplatesTab templates={templates.data ?? []} loading={templates.isLoading} previewId={previewTemplate?.id} onPreview={setPreviewId} />}
          </fieldset>
          {!canEdit && <p className="mt-3 text-[12px] text-gray-500">You can view these settings. Changing them needs the Invoice Templates edit permission.</p>}
        </div>

        {/* Wide screens: preview beside the settings. Narrower (incl. phones): settings first, the preview in a large dialog on demand — never an unreadably small A4. */}
        <div className="hidden min-w-0 min-[1400px]:block">{preview}</div>
        <div className="min-[1400px]:hidden">
          <button type="button" className="btn-outline w-full" onClick={() => setMobilePreview(true)}>
            <Eye className="h-4 w-4" strokeWidth={1.5} /> Preview invoice
          </button>
        </div>
      </div>
      <Modal open={mobilePreview} onClose={() => setMobilePreview(false)} size="xl" title="Invoice preview" maxHeight="max-h-[92vh]">
        {preview}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------ preview --- */

function Preview({ template, print, templates, onPick }: { template: InvoiceTemplateRecord; print: PrintSettings; templates: InvoiceTemplateRecord[]; onPick: (id: string) => void }) {
  const [mode, setMode] = useState<InvoiceTaxMode>(sampleModeFor(template.supportedMode));
  const effective: InvoiceTaxMode = template.supportedMode === 'BOTH' ? mode : template.supportedMode;
  const model = useSampleModel(template, effective, print);
  const images = useCompanyImages();
  return (
    <div className="rounded-lg border border-line bg-gray-100 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[12.5px] text-gray-600">
          Template
          <Select size="sm" className="w-[190px]" value={template.id} placeholder="" onChange={onPick} options={templates.map((t) => ({ value: t.id, label: `${t.templateName}${t.isDefault ? ' (default)' : ''}` }))} />
        </label>
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-[12.5px]" role="group" aria-label="Sample bill tax mode">
          {(['WITH_GST', 'WITHOUT_GST'] as const).map((m) => {
            const allowed = template.supportedMode === 'BOTH' || template.supportedMode === m;
            return (
              <button key={m} type="button" disabled={!allowed} aria-pressed={effective === m} onClick={() => setMode(m)} className={cx('rounded-md px-3 py-1 transition-colors duration-150 disabled:opacity-40', effective === m ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-50')}>
                {m === 'WITH_GST' ? 'With GST' : 'Without GST'}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[12px] text-gray-500">Sample bill · not saved</span>
      </div>
      <InvoiceSheet model={model} images={images} maxScale={1} className="mx-auto max-w-[820px]" />
    </div>
  );
}

/* --------------------------------------------------------------- tabs --- */

type TabProps = { draft: PrintSettings; set: (p: Partial<PrintSettings>) => void };
const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
  <section className="space-y-2.5">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-gray-500">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);
const Note = ({ children }: { children: ReactNode }) => <p className="text-[12px] leading-snug text-gray-500">{children}</p>;

function Branding({ draft, set, canEdit }: TabProps & { canEdit: boolean }) {
  const company = useCompanyProfile().data;
  const can = useAuthStore((s) => s.can);
  const place = [company?.city, company?.state].filter(Boolean).join(', ');
  const lines = [company?.addressLine1, company?.addressLine2, [place, company?.pincode].filter(Boolean).join(' - ')].filter(Boolean);
  return (
    <>
      <Section title="Company" action={can('admin_companies', 'update') && <Link to="/modules/settings/companies" className="text-[12.5px] text-primary hover:underline">Edit details</Link>}>
        {company ? (
          <div className="rounded-md border border-line px-3 py-2 text-[13px] leading-snug">
            <div className="font-medium text-gray-900">{company.name}</div>
            {lines.map((l) => <div key={l} className="text-gray-600">{l}</div>)}
            {company.phone && <div className="text-gray-600">Phone: {company.phone}</div>}
            {company.taxId && <div className="text-gray-600">GSTIN: {company.taxId}</div>}
          </div>
        ) : (
          <Note>No company yet — add one in Settings → Companies.</Note>
        )}
        <Note>Name, address, mobile and GSTIN come from the company — one place for them, used by every invoice.</Note>
      </Section>
      <Section title="Logo" action={<Switch checked={draft.showLogo} onChange={(v) => set({ showLogo: v })} label="Show logo" />}>
        {company && <CompanyLogoField companyId={company.id} logoUpdatedAt={company.logo ? new Date(Number(company.logo.version)).toISOString() : null} />}
      </Section>
      <Section title="Authorised signature" action={<Switch checked={draft.showSignature} onChange={(v) => set({ showSignature: v })} label="Show signature" />}>
        <PrintAssetField kind="SIGNATURE" version={company?.signature?.version} canEdit={canEdit} hint="Transparent PNG works best. Printed above “Authorised Signatory” on templates that show the signatory." />
      </Section>
      <Section title="Footer / terms image" action={<Switch checked={draft.showFooterImage} onChange={(v) => set({ showFooterImage: v })} label="Show image" />}>
        <PrintAssetField kind="FOOTER" version={company?.footerImage?.version} canEdit={canEdit} hint="Optional — a terms graphic or brand mark, at the lower left. PNG or JPEG, up to 1 MB." />
      </Section>
    </>
  );
}

function DocumentTab({ draft, set }: TabProps) {
  return (
    <>
      <Section title="Copy label">
        <Select value={draft.copyLabel} placeholder="" onChange={(v) => set({ copyLabel: v as PrintSettings['copyLabel'] })} options={INVOICE_COPY_LABELS.map((c) => ({ value: c, label: INVOICE_COPY_LABEL_TEXT[c] }))} />
        <Note>Printed at the top right. The invoice preview can print a Duplicate or Office Copy on demand — it is only a label, never a second bill.</Note>
      </Section>
      <Section title="Accent">
        <div role="radiogroup" aria-label="Invoice accent" className="flex flex-wrap gap-2">
          {INVOICE_ACCENTS.map((a) => {
            const on = draft.accent === a;
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={on}
                title={INVOICE_ACCENT_LABELS[a]}
                onClick={() => set({ accent: a })}
                className={cx('flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', on ? 'border-primary/50 bg-primary-50 text-primary-dark' : 'border-line text-gray-600 hover:bg-gray-50')}
              >
                {/* The swatch is the printed colour itself — paper colours, not theme colours. */}
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: INVOICE_ACCENT_COLORS[a] }} aria-hidden />
                {INVOICE_ACCENT_LABELS[a]}
                {on && <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />}
              </button>
            );
          })}
        </div>
        <Note>Tints rules and headings only; every accent prints clearly in black and white.</Note>
      </Section>
      <Section title="Page">
        <Switch checked={draft.showPageNumbers} onChange={(v) => set({ showPageNumbers: v })} label="Page numbers in the PDF (Page 1 of 2)" />
        <Note>Paper size (A4 / A5), columns and totals belong to each template — edit them in Invoice Templates.</Note>
      </Section>
      <Section title="Invoice note">
        <TextArea aria-label="Invoice note" value={draft.invoiceNote} maxLength={PRINT_SETTINGS_LIMITS.invoiceNote} onChange={(e) => set({ invoiceNote: e.target.value })} className="min-h-[64px] text-[13px]" placeholder="e.g. Photos are kept for 90 days after delivery." />
      </Section>
      <Section title="New bills">
        <Field label="Default delivery days" hint="A new bill suggests Planned Delivery = Bill Date + these days. The operator can change it; saved bills never change. Leave blank for no suggestion.">
          <TextInput
            type="number"
            min={0}
            max={PRINT_SETTINGS_LIMITS.maxDeliveryDays}
            inputMode="numeric"
            className="w-[120px]"
            value={draft.defaultDeliveryDays ?? ''}
            onChange={(e) => set({ defaultDeliveryDays: e.target.value === '' ? null : Math.max(0, Math.min(PRINT_SETTINGS_LIMITS.maxDeliveryDays, Math.trunc(Number(e.target.value)))) })}
          />
        </Field>
      </Section>
    </>
  );
}

function PaymentTab({ draft, set }: TabProps) {
  const b = draft.bank;
  const setBank = (patch: Partial<PrintSettings['bank']>) => set({ bank: { ...b, ...patch } });
  const bankField = (key: keyof PrintSettings['bank'], label: string, placeholder?: string) => (
    <Field label={label}>
      <TextInput size="sm" value={b[key]} maxLength={PRINT_SETTINGS_LIMITS.bankField} placeholder={placeholder} onChange={(e) => setBank({ [key]: key === 'ifsc' ? e.target.value.toUpperCase() : e.target.value })} disabled={!draft.showBankDetails} />
    </Field>
  );
  return (
    <>
      <Section title="Bank details" action={<Switch checked={draft.showBankDetails} onChange={(v) => set({ showBankDetails: v })} label="Show bank details" />}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {bankField('bankName', 'Bank name')}
          {bankField('accountName', 'Account name')}
          {bankField('accountNumber', 'Account number')}
          {bankField('ifsc', 'IFSC')}
          <div className="col-span-2">{bankField('branch', 'Branch')}</div>
        </div>
        <Note>Printed for customers to pay into — display text only. Only filled-in lines print; with none, the section disappears.</Note>
      </Section>
      <Section title="Terms & conditions" action={<Switch checked={draft.showTerms} onChange={(v) => set({ showTerms: v })} label="Show terms" />}>
        <TextArea aria-label="Terms and conditions" value={draft.terms} maxLength={PRINT_SETTINGS_LIMITS.terms} disabled={!draft.showTerms} onChange={(e) => set({ terms: e.target.value })} className="min-h-[96px] text-[13px]" />
        <Note>Printed by templates that show terms without text of their own (Legacy Studio does). Up to {PRINT_SETTINGS_LIMITS.terms} characters.</Note>
      </Section>
      <Section title="Footer text">
        <TextInput aria-label="Footer text" value={draft.footerText} maxLength={PRINT_SETTINGS_LIMITS.footerText} onChange={(e) => set({ footerText: e.target.value })} placeholder="e.g. Thank you for choosing us" />
      </Section>
    </>
  );
}

function TemplatesTab({ templates, loading, previewId, onPreview }: { templates: InvoiceTemplateRecord[]; loading: boolean; previewId?: string; onPreview: (id: string) => void }) {
  const setDefault = useSave({ invalidate: [TEMPLATES_KEY, 'bill-invoice'] });
  const canDefault = useAuthStore((s) => s.can)(PERMISSION, 'update');
  const rows = useMemo(() => templates.filter((t) => t.isActive), [templates]);
  if (loading) return <div className="py-6 text-center"><Spinner className="inline h-5 w-5" /></div>;
  return (
    <>
      <Note>The default template prints every bill unless another is chosen in the invoice preview. Legacy Studio follows the studio’s old bill layout.</Note>
      <ul className="divide-y divide-line rounded-md border border-line">
        {rows.map((t) => (
          <li key={t.id} className={cx('flex items-center gap-2 px-3 py-2', previewId === t.id && 'bg-primary-50/60')}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-gray-900">{t.templateName}</div>
              <div className="text-[12px] text-gray-500">{t.config.page.paperSize} · {t.layoutPreset.charAt(0) + t.layoutPreset.slice(1).toLowerCase()}</div>
            </div>
            <button type="button" className="row-action" title="Preview" aria-label={`Preview ${t.templateName}`} onClick={() => onPreview(t.id)}>
              <Eye className="h-4 w-4" strokeWidth={1.5} />
            </button>
            {t.isDefault ? (
              <span className="badge bg-primary-50 text-primary-dark"><Star className="mr-1 h-3 w-3" strokeWidth={2} />Default</span>
            ) : (
              canDefault && <button type="button" className="btn-ghost h-7 px-2 text-[12.5px]" disabled={setDefault.isPending} onClick={() => setDefault.mutate({ method: 'post', url: `/api/settings/invoice-templates/${t.id}/default` })}>Make default</button>
            )}
          </li>
        ))}
      </ul>
      <Link to="/modules/settings/invoice-templates" className="inline-block text-[12.5px] text-primary hover:underline">Manage templates — columns, totals, paper size</Link>
    </>
  );
}
