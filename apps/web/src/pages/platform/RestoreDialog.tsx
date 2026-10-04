import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Field, Modal, Spinner, TextInput } from '@/components/ui';
import { saveFile } from '@/lib/invoice';
import { platformApi } from '@/lib/platformApi';
import { useDateFormatters } from '@/lib/settings';
import { toast } from '@/lib/toast';
import { usePlatformSave, type StudioDetail } from './queries';

/*
 * Restore a studio from its own backup ZIP (docs/SUBSCRIPTIONS.md → Restore). The server enforces
 * every rule (same studio only, suspended only, snapshot first); this dialog explains them and asks
 * for the studio's name as a deliberate confirmation, because the studio's current data is replaced.
 */

interface Snapshot {
  id: string;
  sizeBytes: number;
  restoredFrom: string | null;
  createdAt: string;
  createdBy: string | null;
}
interface RestoreResult {
  counts: Record<string, number>;
  restoredFrom: string;
  usersWithoutPassword: number;
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

function SnapshotList({ studio }: { studio: StudioDetail }) {
  const fmt = useDateFormatters();
  const q = useQuery({ queryKey: ['platform', 'studio', studio.id, 'snapshots'], queryFn: () => platformApi.get<Snapshot[]>(`/api/platform/studios/${studio.id}/restore-snapshots`) });
  const download = async (s: Snapshot) => {
    try {
      saveFile(await platformApi.blob(`/api/platform/studios/${studio.id}/restore-snapshots/${s.id}`), `${studio.slug}-before-restore-${s.createdAt.slice(0, 16).replace(/[:T]/g, '-')}.zip`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download the snapshot');
    }
  };
  if (!q.data?.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1 text-[13px] font-medium text-gray-800">Before-restore snapshots</div>
      <p className="mb-2 text-[12px] text-gray-500">The data as it was just before each restore. Restore one of these files to undo that restore.</p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {q.data.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
            <span className="min-w-0 truncate">{fmt.stampTime(s.createdAt)} · {kb(s.sizeBytes)}{s.createdBy ? ` · ${s.createdBy}` : ''}</span>
            <button type="button" className="row-action" title="Download snapshot" aria-label={`Download snapshot of ${fmt.stampTime(s.createdAt)}`} onClick={() => download(s)}><Download className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RestoreDialog({ studio, open, onClose }: { studio: StudioDetail; open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState('');
  const save = usePlatformSave<RestoreResult>({
    onSuccess: (r) => {
      if (r?.usersWithoutPassword) toast.info(`${r.usersWithoutPassword} restored user(s) need a new password — reset the owner's from this page.`);
      close();
    },
  });
  const close = () => {
    setFile(null);
    setConfirm('');
    onClose();
  };
  const suspended = !studio.isActive;
  const confirmed = confirm.trim() === studio.name.trim();
  const submit = () => {
    if (!file || !confirmed || !suspended) return;
    const body = new FormData();
    body.append('file', file);
    save.mutate({ method: 'post', url: `/api/platform/studios/${studio.id}/restore`, body });
  };
  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      title={`Restore data — ${studio.name}`}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={close}>Cancel</button>
          <button type="button" className="btn-danger" disabled={!file || !confirmed || !suspended || save.isPending} onClick={submit}>{save.isPending && <Spinner />} Replace data with backup</button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-gray-700">
        <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
          Everything this studio has now — bills, receipts, appointments, masters, users, settings — is <b>replaced</b> by the backup. Work done after the backup was taken is removed. The current data is saved first as a snapshot, so this can be undone.
        </p>
        {!suspended && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-700">Suspend the studio first, so nobody is working in it during the restore. Activate it again afterwards.</p>}
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-gray-500">
          <li>Only a backup of this same studio can be restored here.</li>
          <li>Users keep their current passwords; a restored user who no longer exists needs a reset.</li>
          <li>Bill and receipt numbers issued after the backup will be issued again.</li>
          <li>The subscription is not changed. Shared invoice links stop working.</li>
        </ul>
        <Field label="Backup file (.zip from Download backup)" required>
          <input type="file" accept=".zip,application/zip" className="block w-full text-[13px] file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-[13px]" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label={<>Type the studio name to confirm: <b>{studio.name}</b></>} required>
          <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </Field>
        <SnapshotList studio={studio} />
      </div>
    </Modal>
  );
}
