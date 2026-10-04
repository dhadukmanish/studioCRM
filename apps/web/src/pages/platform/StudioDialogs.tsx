import { useForm } from 'react-hook-form';
import { cancelSubscriptionSchema, ownerPasswordSchema, PLAN_KIND_LABELS, updateStudioSchema } from '@erp/shared';
import { Field, Modal, Spinner, TextInput } from '@/components/ui';
import { useDateFormatters } from '@/lib/settings';
import { applyPlatformErrors, checkWith, usePlatformSave, type Period, type StudioDetail } from './queries';

/*
 * The studio detail page's small dialogs. The mutation lives in the dialog (its footer shows the
 * pending state); the form is a child rendered only while the dialog is open, so it always starts
 * from fresh defaults.
 */

type Save = ReturnType<typeof usePlatformSave>;

const footer = (formId: string, label: string, save: Save, onClose: () => void, danger = false, dismiss = 'Cancel') => (
  <>
    <button type="button" className="btn-outline" onClick={onClose}>{dismiss}</button>
    <button type="submit" form={formId} className={danger ? 'btn-danger' : 'btn-primary'} disabled={save.isPending}>{save.isPending && <Spinner />} {label}</button>
  </>
);

function RenameForm({ studio, save }: { studio: StudioDetail; save: Save }) {
  const { register, handleSubmit, setError, formState: { errors } } = useForm({ defaultValues: { name: studio.name } });
  const submit = handleSubmit((v) => {
    const body = checkWith(updateStudioSchema, v, setError as never);
    if (body) save.mutate({ method: 'put', url: `/api/platform/studios/${studio.id}`, body }, { onError: (e) => applyPlatformErrors(e, setError as never) });
  });
  return (
    <form id="platform-rename" onSubmit={submit} noValidate>
      <Field label="Studio name" required error={errors.name?.message}><TextInput {...register('name')} /></Field>
    </form>
  );
}

export function RenameDialog({ studio, open, onClose }: { studio: StudioDetail; open: boolean; onClose: () => void }) {
  const save = usePlatformSave({ onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Rename studio" footer={footer('platform-rename', 'Rename', save, onClose)}>
      <RenameForm studio={studio} save={save} />
    </Modal>
  );
}

function OwnerPasswordForm({ studio, save }: { studio: StudioDetail; save: Save }) {
  const { register, handleSubmit, setError, formState: { errors } } = useForm({ defaultValues: { password: '' } });
  const submit = handleSubmit((v) => {
    const body = checkWith(ownerPasswordSchema, v, setError as never);
    if (body) save.mutate({ method: 'post', url: `/api/platform/studios/${studio.id}/owner-password`, body }, { onError: (e) => applyPlatformErrors(e, setError as never) });
  });
  return (
    <form id="platform-owner-password" onSubmit={submit} noValidate className="grid gap-3">
      <p className="text-[13px] text-gray-600">Sets a new sign-in password for <span className="font-medium text-gray-900">{studio.owner?.name}</span> ({studio.owner?.email}). Share it with the owner.</p>
      <Field label="New password" required error={errors.password?.message} hint="At least 8 characters"><TextInput type="password" autoComplete="new-password" {...register('password')} /></Field>
    </form>
  );
}

export function OwnerPasswordDialog({ studio, open, onClose }: { studio: StudioDetail; open: boolean; onClose: () => void }) {
  const save = usePlatformSave({ onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Reset owner password" footer={footer('platform-owner-password', 'Reset password', save, onClose)}>
      <OwnerPasswordForm studio={studio} save={save} />
    </Modal>
  );
}

function CancelPeriodForm({ studio, period, save }: { studio: StudioDetail; period: Period; save: Save }) {
  const fmt = useDateFormatters();
  const { register, handleSubmit, setError, formState: { errors } } = useForm({ defaultValues: { reason: '' } });
  const submit = handleSubmit((v) => {
    const body = checkWith(cancelSubscriptionSchema, v, setError as never);
    if (body) save.mutate({ method: 'post', url: `/api/platform/studios/${studio.id}/subscriptions/${period.id}/cancel`, body }, { onError: (e) => applyPlatformErrors(e, setError as never) });
  });
  return (
    <form id="platform-cancel-period" onSubmit={submit} noValidate className="grid gap-3">
      <p className="text-[13px] text-gray-600">
        Cancel <span className="font-medium text-gray-900">{period.planName}</span> ({PLAN_KIND_LABELS[period.kind]}, {fmt.date(period.startsOn)} to {fmt.date(period.endsOn)}) for {studio.name}? The days it gave are removed; the record stays in the history.
      </p>
      <Field label="Reason" required error={errors.reason?.message}><TextInput {...register('reason')} /></Field>
    </form>
  );
}

export function CancelPeriodDialog({ studio, period, onClose }: { studio: StudioDetail; period: Period | null; onClose: () => void }) {
  const save = usePlatformSave({ onSuccess: onClose });
  return (
    <Modal open={!!period} onClose={onClose} size="sm" title="Cancel subscription period" footer={footer('platform-cancel-period', 'Cancel period', save, onClose, true, 'Keep it')}>
      {period && <CancelPeriodForm studio={studio} period={period} save={save} />}
    </Modal>
  );
}
