import { useRef } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { INVOICE_COLORS, LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, PRINT_ASSET_LABELS, type PrintAssetKind } from '@erp/shared';
import { Spinner } from '@/components/ui';
import { useSave } from '@/lib/queries';
import { usePrintAsset } from '@/lib/settings';
import { toast } from '@/lib/toast';
import { webpToPng } from '../CompanyLogoField';

const ACCEPT = LOGO_CONTENT_TYPES.join(',');

/**
 * One print image (authorised signature / footer image). Like the company logo it saves on its own
 * endpoint the moment a file is chosen — an image is not a text field, and waiting for Save could
 * lose it to Cancel. The 1 MB / PNG-JPEG-WebP checks here only give a quick message; the server
 * re-checks the size and reads the file's own bytes. WebP is converted to PNG here, because the
 * invoice PDF can embed PNG and JPEG only.
 */
export function PrintAssetField({ kind, version, canEdit, hint }: { kind: PrintAssetKind; version?: string | null; canEdit: boolean; hint: string }) {
  const img = usePrintAsset(kind, version);
  const input = useRef<HTMLInputElement>(null);
  const label = PRINT_ASSET_LABELS[kind];
  const invalidate = ['companies', 'bill-invoice'];
  const upload = useSave<FormData>({ invalidate });
  const remove = useSave({ invalidate });
  const busy = upload.isPending || remove.isPending;
  const url = `/api/settings/print-assets/${kind.toLowerCase()}`;

  const pick = async (file?: File) => {
    if (!file) return;
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) return toast.error(`The ${label.toLowerCase()} must be a PNG, JPEG or WebP image`);
    let toSend = file;
    if (file.type === 'image/webp') {
      try {
        toSend = await webpToPng(file);
      } catch {
        return toast.error('This WebP image could not be read — try a PNG or JPEG');
      }
    }
    if (toSend.size > LOGO_MAX_BYTES) return toast.error(`The ${label.toLowerCase()} must be 1 MB or smaller`);
    const body = new FormData();
    body.append('file', toSend);
    upload.mutate({ method: 'put', url, body });
  };

  return (
    <div className="flex items-center gap-3">
      {/* Paper white in every theme (a dark-ink signature must stay visible in Dark): what the image looks like printed. Aspect ratio kept. */}
      <div className="flex h-14 w-32 shrink-0 items-center justify-center rounded-md border border-line" style={{ background: INVOICE_COLORS.paper }} aria-label={`${label} preview`}>
        {version && img.data ? <img src={img.data} alt={label} className="max-h-12 max-w-[7.5rem] object-contain" /> : <span className="text-[12px]" style={{ color: INVOICE_COLORS.muted }}>{version && img.isLoading ? 'Loading…' : `No ${label.toLowerCase()}`}</span>}
      </div>
      <div className="min-w-0">
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-label={`Choose ${label.toLowerCase()} file`} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="btn-outline" disabled={busy} onClick={() => input.current?.click()}>
              {upload.isPending ? <Spinner /> : <ImageUp className="h-4 w-4" strokeWidth={1.5} />} {version ? 'Replace' : 'Upload'}
            </button>
            {version && (
              <button type="button" className="btn-ghost text-red-600" disabled={busy} onClick={() => remove.mutate({ method: 'delete', url })}>
                {remove.isPending ? <Spinner /> : <Trash2 className="h-4 w-4" strokeWidth={1.5} />} Remove
              </button>
            )}
          </div>
        )}
        <p className="mt-1 text-[12px] leading-snug text-gray-500">{hint}</p>
      </div>
    </div>
  );
}
