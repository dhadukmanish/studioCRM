import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, MessageCircle } from 'lucide-react';
import { isTemplateCompatible, whatsappChatUrl, whatsappDestination } from '@erp/shared';
import { Field, Modal, Select, Spinner, TextArea, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { fetchInvoicePdf, recordInvoiceShareOpened, saveFile, useInvoiceShare, useInvoiceTemplateLookup } from '@/lib/invoice';

/**
 * Share a SAVED bill's invoice on WhatsApp (docs/WHATSAPP_SHARING.md).
 *
 * Honest by design: WhatsApp's click-to-chat link can prefill the number and the text, but it can
 * NOT attach a file. So the dialog prepares the real invoice PDF first (the same PDF Download
 * gives), and "Open WhatsApp" — one click — downloads it and opens the chat; the operator attaches
 * the file before sending. Nothing here claims the PDF was attached or the message was sent.
 *
 * The number defaults to the bill's saved mobile; changing it here affects this share only — the
 * bill is never edited. The template defaults to the one the preview shows (or the default).
 */
export function ShareInvoiceDialog({ billId, open, onClose, templateId }: { billId: string | null; open: boolean; onClose: () => void; templateId?: string }) {
  const ctx = useInvoiceShare(open && billId ? billId : undefined);
  const lookup = useInvoiceTemplateLookup();
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('');
  const [template, setTemplate] = useState('');
  const [opened, setOpened] = useState(false);

  const compatible = useMemo(() => (ctx.data ? (lookup.data ?? []).filter((t) => isTemplateCompatible(t.supportedMode, ctx.data!.taxMode)) : []), [lookup.data, ctx.data]);

  // Start every opening from the saved bill, never from a previous share's edits.
  useEffect(() => {
    if (!open || !ctx.data) return;
    setNumber(ctx.data.mobileNumber);
    setMessage(ctx.data.message);
    setOpened(false);
  }, [open, ctx.data]);
  useEffect(() => {
    if (!open) return;
    setTemplate(templateId ?? compatible.find((t) => t.isDefault)?.id ?? compatible[0]?.id ?? '');
  }, [open, templateId, compatible]);

  // The invoice is prepared as soon as the dialog knows which template to use, so the final click
  // only has to hand the file to the browser and open the chat — nothing async stands between the
  // click and the new tab, which is what keeps popup blockers out of the way.
  const pdf = useQuery({
    queryKey: ['bill-invoice-share-pdf', billId, template],
    queryFn: () => fetchInvoicePdf(billId!, template || undefined),
    enabled: open && !!billId && !!ctx.data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const dest = whatsappDestination(number);
  const text = message.trim();
  const ready = dest.ok && !!pdf.data && !!text && !pdf.isFetching;
  const url = ready && dest.ok ? whatsappChatUrl(dest.digits, text) : undefined;
  const fileName = ctx.data?.fileName ?? 'Invoice.pdf';

  const onOpenWhatsApp = () => {
    if (!ready || !pdf.data) return;
    saveFile(pdf.data, fileName);
    void recordInvoiceShareOpened(billId!, template || undefined);
    setOpened(true);
    // The link itself opens WhatsApp (target=_blank) — a direct user action, never a scripted popup.
  };

  const pdfError = pdf.error instanceof ApiError ? pdf.error.message : pdf.error ? 'The invoice PDF could not be prepared. Try again in a moment.' : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share invoice on WhatsApp"
      size="md"
      footer={
        opened ? (
          <>
            <button type="button" className="btn-outline" onClick={() => pdf.data && saveFile(pdf.data, fileName)}>
              <Download className="h-4 w-4" strokeWidth={1.5} /> Download again
            </button>
            {url && <a className="btn-outline" href={url} target="_blank" rel="noopener noreferrer">Open WhatsApp again</a>}
            <button type="button" className="btn-primary" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            {url ? (
              <a className="btn-primary" href={url} target="_blank" rel="noopener noreferrer" onClick={onOpenWhatsApp}>
                <MessageCircle className="h-4 w-4" strokeWidth={1.5} /> Open WhatsApp
              </a>
            ) : (
              <button type="button" className="btn-primary" disabled>
                <MessageCircle className="h-4 w-4" strokeWidth={1.5} /> Open WhatsApp
              </button>
            )}
          </>
        )
      }
    >
      {ctx.isLoading ? (
        <div className="py-8 text-center"><Spinner className="inline h-5 w-5" /></div>
      ) : ctx.error || !ctx.data ? (
        <p className="text-[13px] text-red-600">{ctx.error instanceof ApiError ? ctx.error.message : 'This invoice cannot be shared right now.'}</p>
      ) : opened ? (
        <div className="space-y-3 text-[13.5px] text-gray-700">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} />
            <span>
              Invoice PDF downloaded: <span className="font-medium text-gray-900">{fileName}</span>. <b className="font-semibold">Attach it in WhatsApp before sending.</b>
            </span>
          </p>
          <p className="text-gray-500">
            WhatsApp opened in a new tab for {dest.ok ? dest.display : number}, with the message filled in. Nothing is sent until you press send in WhatsApp.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
            <span className="font-medium text-gray-900">{ctx.data.customerName}</span>
            <span className="text-gray-500">Invoice {ctx.data.documentLabel} · {ctx.data.grandTotal}</span>
          </div>
          <Field label="WhatsApp number" error={dest.ok ? undefined : dest.error} hint={dest.ok ? `Opens a chat with ${dest.display}. The bill is not changed.` : undefined}>
            <TextInput value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" autoComplete="off" aria-label="WhatsApp number" />
          </Field>
          <Field label="Template">
            <Select
              value={template}
              onChange={(v) => setTemplate(v)}
              placeholder="Default"
              options={compatible.map((t) => ({ value: t.id, label: `${t.templateName}${t.isDefault ? ' (default)' : ''}` }))}
            />
          </Field>
          <Field label="Message" hint="Edit it freely — it is only for this share.">
            <TextArea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} aria-label="Message" />
          </Field>
          <div className="flex items-start gap-2 rounded-lg border border-line bg-gray-50 px-3 py-2 text-[13px]" role="status" aria-live="polite">
            {pdf.isFetching ? (
              <><Spinner className="mt-0.5" /><span className="text-gray-600">Preparing invoice…</span></>
            ) : pdfError ? (
              <><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.5} /><span className="text-gray-700">{pdfError}</span></>
            ) : pdf.data ? (
              <><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} /><span className="text-gray-700">Invoice ready — <span className="font-medium">{fileName}</span>. Open WhatsApp downloads it; attach it in WhatsApp before sending.</span></>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
