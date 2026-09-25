import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, MessageCircle } from 'lucide-react';
import { INVOICE_LINK_PLACEHOLDER, fillInvoiceLink, isTemplateCompatible, whatsappChatUrl, whatsappDestination, type PreparedPublicInvoiceLink } from '@erp/shared';
import { ConfirmDialog, Field, Modal, Select, Spinner, TextArea, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { preparePublicInvoiceLink, recordInvoiceShareOpened, revokePublicInvoiceLink, useInvoiceShare, useInvoiceTemplateLookup, usePublicInvoiceLink } from '@/lib/invoice';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';

/**
 * Share a SAVED bill's invoice on WhatsApp (docs/WHATSAPP_SHARING.md, Phase 5.1).
 *
 * The message carries a secure public invoice link: the customer taps it and the invoice PDF opens
 * — no login, no attachment, no need to be in the operator's contacts. The dialog never creates a
 * link just by opening: it shows the bill's live link if it has one for the chosen template, and
 * otherwise the operator creates it ("Create link"). The server reuses a live link for the same
 * template and bill revision instead of minting a new one on every share.
 *
 * "Open WhatsApp" opens click-to-chat with the number and the message; the operator presses Send.
 * Nothing here claims the message was sent, delivered or read.
 *
 * The number defaults to the bill's saved mobile; changing it here affects this share only — the
 * bill is never edited. The template defaults to the one the preview shows (or the default).
 */
export function ShareInvoiceDialog({ billId, open, onClose, templateId }: { billId: string | null; open: boolean; onClose: () => void; templateId?: string }) {
  const active = open && billId ? billId : undefined;
  const ctx = useInvoiceShare(active);
  const linkState = usePublicInvoiceLink(active);
  const lookup = useInvoiceTemplateLookup();
  const { stampTime } = useDateFormatters();
  // Withdrawing a link a customer may already have is a state change: Billing UPDATE (the API enforces it).
  const canRevoke = useAuthStore((s) => s.can)('operations_billing', 'update');
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('');
  const [template, setTemplate] = useState('');
  const [prepared, setPrepared] = useState<{ requested: string | null; link: PreparedPublicInvoiceLink } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [opened, setOpened] = useState(false);

  const compatible = useMemo(() => (ctx.data ? (lookup.data ?? []).filter((t) => isTemplateCompatible(t.supportedMode, ctx.data!.taxMode)) : []), [lookup.data, ctx.data]);

  // Start every opening from the saved bill, never from a previous share's edits.
  useEffect(() => {
    if (!open || !ctx.data) return;
    setNumber(ctx.data.mobileNumber);
    setMessage(ctx.data.message);
    setOpened(false);
  }, [open, ctx.data]);
  // A real template id whenever one exists: the link records the template it was made with, so the
  // picker's blank "Default" option must mean the actual default, never "unspecified".
  const fallbackTemplate = compatible.find((t) => t.isDefault)?.id ?? compatible[0]?.id ?? '';
  useEffect(() => {
    if (!open) return;
    setTemplate(templateId ?? fallbackTemplate);
  }, [open, templateId, fallbackTemplate]);
  useEffect(() => {
    if (!open) {
      setPrepared(null);
      setLinkError(null);
    }
  }, [open]);

  const chosen = template || null;
  // The link that goes in this message: one prepared in this dialog for this template (matched on
  // what was REQUESTED, so a server-side resolution can never leave the dialog stuck), or the bill's
  // live link when it already serves this template. Anything else must be (re)created.
  const current = prepared && prepared.requested === chosen ? prepared.link : linkState.data?.active && linkState.data.templateId === chosen ? linkState.data : null;
  const url = current?.url ?? null;
  const otherLink = !url && linkState.data?.active ? linkState.data : null;

  // The draft keeps the literal {InvoiceLink}; the operator sees (and edits around) the real URL
  // once a link is ready. So a template switch, a new link or a revoke never leaves a stale URL.
  const shown = url ? message.split(INVOICE_LINK_PLACEHOLDER).join(url) : message;
  const onMessage = (v: string) => setMessage(url ? v.split(url).join(INVOICE_LINK_PLACEHOLDER) : v);

  const dest = whatsappDestination(number);
  const text = message.trim();
  const linkMissing = !!url && !!text && !text.includes(INVOICE_LINK_PLACEHOLDER);
  // The link always travels: if the operator deleted it, it is added back at the end (and the dialog says so).
  const finalText = url && text ? fillInvoiceLink(text, url) : '';
  const chatUrl = dest.ok && finalText ? whatsappChatUrl(dest.digits, finalText) : undefined;

  const createLink = async () => {
    if (!billId) return;
    setPreparing(true);
    setLinkError(null);
    try {
      const requested = chosen;
      setPrepared({ requested, link: await preparePublicInvoiceLink(billId, requested ?? undefined) });
      void linkState.refetch();
    } catch (e) {
      setLinkError(e instanceof ApiError ? e.message : 'The invoice link could not be created. Try again in a moment.');
    } finally {
      setPreparing(false);
    }
  };

  const revoke = async () => {
    if (!billId) return;
    setRevoking(true);
    try {
      await revokePublicInvoiceLink(billId);
      setPrepared(null);
      await linkState.refetch();
      setConfirmRevoke(false);
    } catch (e) {
      setLinkError(e instanceof ApiError ? e.message : 'The invoice link could not be revoked. Try again.');
      setConfirmRevoke(false);
    } finally {
      setRevoking(false);
    }
  };

  const onOpenWhatsApp = () => {
    if (!chatUrl) return;
    void recordInvoiceShareOpened(billId!, chosen ?? undefined);
    setOpened(true);
    // The link itself opens WhatsApp (target=_blank) — a direct user action, never a scripted popup.
  };

  const openButton = (label: string, primary: boolean) =>
    chatUrl ? (
      <a className={primary ? 'btn-primary' : 'btn-outline'} href={chatUrl} target="_blank" rel="noopener noreferrer" onClick={onOpenWhatsApp}>
        <MessageCircle className="h-4 w-4" strokeWidth={1.5} /> {label}
      </a>
    ) : (
      <button type="button" className={primary ? 'btn-primary' : 'btn-outline'} disabled title={url ? undefined : 'Create the invoice link first'}>
        <MessageCircle className="h-4 w-4" strokeWidth={1.5} /> {label}
      </button>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share invoice on WhatsApp"
      size="md"
      footer={
        opened ? (
          <>
            {openButton('Open WhatsApp again', false)}
            <button type="button" className="btn-primary" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            {openButton('Open WhatsApp', true)}
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
              WhatsApp opened for <span className="font-medium text-gray-900">{dest.ok ? dest.display : number}</span> with the message and the invoice link. <b className="font-semibold">Press Send in WhatsApp</b> to share it.
            </span>
          </p>
          <p className="text-gray-500">The customer opens the invoice from the link — no login needed. Nothing is sent until you press Send.</p>
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
              onChange={(v) => setTemplate(v || fallbackTemplate)}
              placeholder="Default"
              options={compatible.map((t) => ({ value: t.id, label: `${t.templateName}${t.isDefault ? ' (default)' : ''}` }))}
            />
          </Field>

          <div className="rounded-lg border border-line bg-gray-50 px-3 py-2 text-[13px]" role="status" aria-live="polite">
            {linkState.isLoading || preparing ? (
              <span className="flex items-center gap-2 text-gray-600"><Spinner />{preparing ? 'Preparing the invoice link…' : 'Checking the invoice link…'}</span>
            ) : url ? (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex items-center gap-2 text-gray-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} />
                  Invoice link ready{current?.createdAt ? <span className="text-gray-500">· since {stampTime(current.createdAt)}</span> : null}
                </span>
                {canRevoke && <button type="button" className="btn-ghost h-7 px-2 text-[12.5px] text-gray-600" onClick={() => setConfirmRevoke(true)}>Revoke link</button>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="flex items-start gap-2 text-gray-700">
                  <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" strokeWidth={1.5} />
                  <span>
                    {otherLink
                      ? <>The current link uses {otherLink.templateName ?? 'another template'}. A new link replaces it — the old one stops working.</>
                      : 'A secure link lets the customer open the invoice PDF without logging in.'}
                  </span>
                </span>
                <button type="button" className="btn-outline h-8" onClick={createLink} disabled={lookup.isLoading}>
                  <Link2 className="h-4 w-4" strokeWidth={1.5} /> {otherLink ? 'Replace link' : 'Create link'}
                </button>
              </div>
            )}
            {linkError && (
              <p className="mt-2 flex items-start gap-2 text-gray-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.5} />
                <span>{linkError}</span>
              </p>
            )}
          </div>

          <Field
            label="Message"
            hint={linkMissing ? 'The invoice link is not in the message — it will be added at the end.' : url ? 'Edit it freely — it is only for this share.' : `${INVOICE_LINK_PLACEHOLDER} becomes the invoice link once it is created.`}
          >
            <TextArea rows={8} value={shown} onChange={(e) => onMessage(e.target.value)} maxLength={1200} aria-label="Message" />
          </Field>
        </div>
      )}
      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={revoke}
        loading={revoking}
        title="Revoke the invoice link?"
        message="The link stops working immediately — a customer who opens it will see that it is no longer valid. You can create a new link at any time."
        confirmText="Revoke link"
      />
    </Modal>
  );
}
