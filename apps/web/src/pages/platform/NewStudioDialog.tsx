import { FormProvider, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createStudioSchema } from '@erp/shared';
import { Field, Modal, Spinner, TextInput } from '@/components/ui';
import { applyPlatformErrors, checkWith, usePlatformSave, usePlatformToday, usePlans, type Plan, type StudioDetail } from './queries';
import { blankGrant, choosablePlans, GrantFields, toGrantBody, type GrantValues } from './GrantFields';

interface NewStudioValues {
  studioName: string;
  ownerFirstName: string;
  ownerLastName: string;
  ownerMobile: string;
  ownerEmail: string;
  ownerPassword: string;
  subscription: GrantValues;
}

type Save = ReturnType<typeof usePlatformSave<StudioDetail>>;

/** Mounted only while open, so every new studio starts from blank fields and the trial plan. */
function NewStudioForm({ plans, save }: { plans: Plan[]; save: Save }) {
  const today = usePlatformToday();
  const trial = choosablePlans(plans, false).find((p) => p.kind === 'TRIAL');
  const form = useForm<NewStudioValues>({
    defaultValues: { studioName: '', ownerFirstName: '', ownerLastName: '', ownerMobile: '', ownerEmail: '', ownerPassword: '', subscription: blankGrant(today, trial?.id ?? '') },
  });
  const { register, handleSubmit, setError, formState: { errors } } = form;
  const submit = handleSubmit((v) => {
    const plan = plans.find((p) => p.id === v.subscription.planId);
    const body = checkWith(createStudioSchema, { ...v, subscription: toGrantBody(v.subscription, plan) }, setError as never);
    if (body) save.mutate({ method: 'post', url: '/api/platform/studios', body }, { onError: (e) => applyPlatformErrors(e, setError as never, { map: 'subscription.' }) });
  });
  return (
    <FormProvider {...form}>
      <form id="platform-new-studio" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="Studio name" required error={errors.studioName?.message} className="sm:col-span-2"><TextInput autoFocus {...register('studioName')} /></Field>
        <Field label="Owner first name" required error={errors.ownerFirstName?.message}><TextInput {...register('ownerFirstName')} /></Field>
        <Field label="Owner last name" error={errors.ownerLastName?.message}><TextInput {...register('ownerLastName')} /></Field>
        <Field label="Mobile" required error={errors.ownerMobile?.message}><TextInput inputMode="numeric" maxLength={10} {...register('ownerMobile')} /></Field>
        <Field label="Email" required error={errors.ownerEmail?.message} hint="The owner signs in with this"><TextInput type="email" autoComplete="off" {...register('ownerEmail')} /></Field>
        <Field label="Password" required error={errors.ownerPassword?.message} hint="At least 8 characters — share it with the owner" className="sm:col-span-2"><TextInput type="password" autoComplete="new-password" {...register('ownerPassword')} /></Field>
        <div className="sm:col-span-2 border-t border-line pt-4 text-[12px] font-semibold uppercase tracking-wide text-gray-500">First subscription</div>
        <div className="sm:col-span-2"><GrantFields plans={plans} currentEndsOn={null} hadTrial={false} /></div>
      </form>
    </FormProvider>
  );
}

/** Studios are created only here — there is no public signup. Opens the new studio on success. */
export function NewStudioDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const plans = usePlans();
  const nav = useNavigate();
  const save = usePlatformSave<StudioDetail>({ onSuccess: (s) => { onClose(); if (s?.id) nav(`/platform/studios/${s.id}`); } });
  return (
    <Modal open={open} onClose={onClose} size="lg" title="New studio" footer={<><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button type="submit" form="platform-new-studio" className="btn-primary" disabled={save.isPending || !plans.data}>{save.isPending && <Spinner />} Create studio</button></>}>
      {plans.isLoading ? (
        <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-primary" /></div>
      ) : plans.isError || !plans.data ? (
        <p role="alert" className="text-[13px] text-red-600">Could not load the plans. Close and try again.</p>
      ) : (
        <NewStudioForm plans={plans.data} save={save} />
      )}
    </Modal>
  );
}
