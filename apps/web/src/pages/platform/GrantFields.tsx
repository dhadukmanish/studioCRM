import { useEffect } from 'react';
import { Controller, FormProvider, useForm, useFormContext } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { grantSubscriptionSchema, nextPeriod, planAmount, planDays, PLAN_KIND_LABELS, SUBSCRIPTION_PAYMENT_MODES } from '@erp/shared';
import { DateInput, Field, Modal, Select, Spinner, TextInput } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { applyPlatformErrors, checkWith, PAYMENT_MODE_LABELS, usePlatformSave, usePlatformToday, usePlans, type Plan, type StudioDetail } from './queries';

/** One grant as the form holds it — strings, turned into the API body by `toGrantBody`. */
export interface GrantValues {
  planId: string;
  days: string;
  amount: string;
  paymentMode: string;
  paymentRef: string;
  paidOn: string;
  notes: string;
}
export const blankGrant = (today: string, planId = ''): GrantValues => ({ planId, days: '', amount: '', paymentMode: '', paymentRef: '', paidOn: today, notes: '' });

/** The grant body the API expects; days only for Day-wise, amount never for a trial (blank = list price). */
export function toGrantBody(v: GrantValues, plan: Plan | undefined) {
  return {
    planId: v.planId,
    days: plan?.kind === 'DAYS' && v.days.trim() !== '' ? v.days.trim() : null,
    amount: !plan || plan.kind === 'TRIAL' || v.amount.trim() === '' ? null : v.amount.trim(),
    paymentMode: v.paymentMode || null,
    paymentRef: v.paymentRef,
    paidOn: v.paidOn || null,
    notes: v.notes,
  };
}

const planLabel = (p: Plan) => `${p.name} — ${PLAN_KIND_LABELS[p.kind]}${p.kind === 'TRIAL' ? '' : ` · ${fmtMoney(p.price)}${p.kind === 'DAYS' ? '/day' : ''}`}`;

/** Plans a grant may use: active ones, and a trial only while the studio has not had one. */
export const choosablePlans = (plans: Plan[], hadTrial: boolean) => plans.filter((p) => p.isActive && !(hadTrial && p.kind === 'TRIAL'));

/**
 * The grant fields, shared by the New studio and Add subscription dialogs. Both forms keep them
 * under `subscription.*`. The period preview and the prefilled amount use the shared rules
 * (`nextPeriod`, `planAmount`) for display only — the server dates and prices the period itself.
 */
export function GrantFields({ plans, currentEndsOn, hadTrial }: { plans: Plan[]; currentEndsOn: string | null; hadTrial: boolean }) {
  const { register, control, watch, setValue, formState: { errors } } = useFormContext<{ subscription: GrantValues }>();
  const fmt = useDateFormatters();
  const today = usePlatformToday();
  const options = choosablePlans(plans, hadTrial);
  const [planId, daysText, amount] = watch(['subscription.planId', 'subscription.days', 'subscription.amount']);
  const plan = plans.find((p) => p.id === planId);
  const chosenDays = Number(daysText);
  const days = plan ? planDays(plan, Number.isInteger(chosenDays) ? chosenDays : null) : null;
  const err = errors.subscription;

  // A new plan or a new number of days re-prices the grant at list price; the operator may still edit it.
  useEffect(() => {
    if (!plan || plan.kind === 'TRIAL') return setValue('subscription.amount', '');
    setValue('subscription.amount', days ? planAmount(plan, days) : '');
  }, [plan?.id, days]); // eslint-disable-line react-hooks/exhaustive-deps

  const period = days ? nextPeriod(currentEndsOn, today, days) : null;
  const paid = !!plan && plan.kind !== 'TRIAL' && Number(amount) > 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Plan"
        required
        error={err?.planId?.message}
        hint={options.length ? undefined : <>No active plan yet — <Link to="/platform/plans" className="text-primary underline">create your plans</Link> first.</>}
        className={plan?.kind === 'DAYS' ? undefined : 'sm:col-span-2'}>
        <Controller control={control} name="subscription.planId" render={({ field }) => <Select value={field.value} onChange={field.onChange} placeholder={options.length ? 'Choose a plan' : 'No active plan'} options={options.map((p) => ({ value: p.id, label: planLabel(p) }))} />} />
      </Field>
      {plan?.kind === 'DAYS' && (
        <Field label="Days" required error={err?.days?.message}>
          <TextInput inputMode="numeric" {...register('subscription.days')} placeholder="e.g. 15" />
        </Field>
      )}
      {period && (
        <p className="sm:col-span-2 rounded-lg bg-primary-50 px-3 py-2 text-[13px] text-gray-700" aria-live="polite">
          Runs <span className="font-medium text-gray-900">{fmt.date(period.startsOn)}</span> to <span className="font-medium text-gray-900">{fmt.date(period.endsOn)}</span> ({days} day{days === 1 ? '' : 's'})
          {currentEndsOn && period.startsOn > today ? ' — starts after the current period ends.' : '.'}
        </p>
      )}
      {plan && plan.kind !== 'TRIAL' && (
        <Field label="Amount (₹)" error={err?.amount?.message} hint="List price; change it for a discount">
          <TextInput inputMode="decimal" {...register('subscription.amount')} />
        </Field>
      )}
      {paid && (
        <>
          <Field label="Payment mode" required error={err?.paymentMode?.message}>
            <Controller control={control} name="subscription.paymentMode" render={({ field }) => <Select value={field.value} onChange={field.onChange} placeholder="Choose" options={SUBSCRIPTION_PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))} />} />
          </Field>
          <Field label="Reference" error={err?.paymentRef?.message} hint="UPI / cheque / transaction no.">
            <TextInput {...register('subscription.paymentRef')} />
          </Field>
          <Field label="Paid on" error={err?.paidOn?.message}>
            <Controller control={control} name="subscription.paidOn" render={({ field }) => <DateInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} clearable aria-label="Paid on" />} />
          </Field>
        </>
      )}
      <Field label="Notes" error={err?.notes?.message} className="sm:col-span-2">
        <TextInput {...register('subscription.notes')} />
      </Field>
    </div>
  );
}

type Save = ReturnType<typeof usePlatformSave>;

/** Mounted only while the dialog is open, so its defaults (and the list-price prefill) start fresh each time. */
function GrantForm({ studio, plans, save }: { studio: StudioDetail; plans: Plan[]; save: Save }) {
  const today = usePlatformToday();
  const hadTrial = studio.periods.some((p) => p.kind === 'TRIAL' && p.status === 'ACTIVE');
  // Start from the paid plan the studio is on, when it can still be chosen.
  const last = studio.periods.find((p) => p.status === 'ACTIVE' && p.kind !== 'TRIAL');
  const startPlan = last && choosablePlans(plans, hadTrial).some((p) => p.id === last.planId) ? last.planId : '';
  const form = useForm<{ subscription: GrantValues }>({ defaultValues: { subscription: blankGrant(today, startPlan) } });
  const submit = form.handleSubmit((v) => {
    const plan = plans.find((p) => p.id === v.subscription.planId);
    const body = checkWith(grantSubscriptionSchema, toGrantBody(v.subscription, plan), form.setError as never, 'subscription.');
    if (body) save.mutate({ method: 'post', url: `/api/platform/studios/${studio.id}/subscriptions`, body }, { onError: (e) => applyPlatformErrors(e, form.setError as never, { issues: 'subscription.', map: 'subscription.' }) });
  });
  return (
    <FormProvider {...form}>
      <form id="platform-grant" onSubmit={submit} noValidate>
        <GrantFields plans={plans} currentEndsOn={studio.access.endsOn} hadTrial={hadTrial} />
      </form>
    </FormProvider>
  );
}

/** Add / renew a subscription for an existing studio. */
export function GrantDialog({ studio, open, onClose }: { studio: StudioDetail; open: boolean; onClose: () => void }) {
  const plans = usePlans();
  const save = usePlatformSave({ onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} size="md" title={`Add subscription — ${studio.name}`} footer={<><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button type="submit" form="platform-grant" className="btn-primary" disabled={save.isPending || !plans.data}>{save.isPending && <Spinner />} Add subscription</button></>}>
      {plans.isLoading ? (
        <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-primary" /></div>
      ) : plans.isError || !plans.data ? (
        <p role="alert" className="text-[13px] text-red-600">Could not load the plans. Close and try again.</p>
      ) : (
        <GrantForm studio={studio} plans={plans.data} save={save} />
      )}
    </Modal>
  );
}
