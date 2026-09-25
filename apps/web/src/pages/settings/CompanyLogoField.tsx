import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { Field, Spinner } from '@/components/ui';
import { useSave } from '@/lib/queries';
import { useCompanyLogo } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { toast } from '@/lib/toast';
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from '@erp/shared';

const ACCEPT = LOGO_CONTENT_TYPES.join(',');

/**
 * A company's logo inside the Company form. It saves on its own endpoint the moment a file is
 * chosen, independent of the form's Save: the image is not a text field, and an upload that
 * waited for Save could be lost by Cancel. Saving invalidates `companies`, which also refreshes
 * the company profile, so the sidebar shows the new logo straight away.
 *
 * The 1 MB / PNG-JPEG-WebP checks here are only for a quick message; the server re-checks the
 * size and reads the file's own bytes to decide its type.
 */
export function CompanyLogoField({ companyId, logoUpdatedAt }: { companyId?: string; logoUpdatedAt?: string | null }) {
  const [version, setVersion] = useState<string | null>(logoUpdatedAt ? String(Date.parse(logoUpdatedAt)) : null);
  const logo = useCompanyLogo(companyId, version);
  const input = useRef<HTMLInputElement>(null);
  const canEdit = useAuthStore((s) => s.can)('admin_companies', 'update');
  const upload = useSave<FormData, { version: string }>({ invalidate: ['companies'], onSuccess: (r) => setVersion(r.version) });
  const remove = useSave({ invalidate: ['companies'], onSuccess: () => setVersion(null) });
  const busy = upload.isPending || remove.isPending;

  if (!companyId) {
    return <Field label="Logo"><p className="text-[12.5px] text-gray-500">Save the company first, then add its logo.</p></Field>;
  }

  const pick = (file?: File) => {
    if (!file) return;
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) return toast.error('The logo must be a PNG, JPEG or WebP image');
    if (file.size > LOGO_MAX_BYTES) return toast.error('The logo must be 1 MB or smaller');
    const body = new FormData();
    body.append('file', file);
    upload.mutate({ method: 'put', url: `/api/admin/companies/${companyId}/logo`, body });
  };

  return (
    <Field label="Logo" hint="PNG, JPEG or WebP, up to 1 MB. Shown in the sidebar and, later, on invoices.">
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-32 shrink-0 items-center justify-center rounded-md border border-line bg-white">
          {version && logo.data ? <img src={logo.data} alt="Company logo" className="max-h-14 max-w-[7.5rem] object-contain" /> : <span className="text-[12px] text-gray-400">{version && logo.isLoading ? 'Loading…' : 'No logo'}</span>}
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="btn-outline" disabled={busy} onClick={() => input.current?.click()}>
              {upload.isPending ? <Spinner /> : <ImageUp className="h-4 w-4" strokeWidth={1.5} />} {version ? 'Replace' : 'Upload'}
            </button>
            {version && (
              <button type="button" className="btn-ghost text-red-600" disabled={busy} onClick={() => remove.mutate({ method: 'delete', url: `/api/admin/companies/${companyId}/logo` })}>
                {remove.isPending ? <Spinner /> : <Trash2 className="h-4 w-4" strokeWidth={1.5} />} Remove
              </button>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
