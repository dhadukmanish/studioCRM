import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Field, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { useSave, useSettings } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { THEMES } from '@/lib/theme';

/** Tenant-wide settings. Keys mirror DEFAULT_SETTINGS in apps/api/src/services/settings.ts — add a control here when you add a key there. */
export default function GeneralSettingsPage() {
  const q = useSettings();
  const [s, setS] = useState<Record<string, any>>({});
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const can = useAuthStore((st) => st.can);
  const save = useSave({ invalidate: ['settings'] });
  const set = (k: string, v: any) => setS((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[20px] font-semibold text-gray-900">General Settings</h2>
        <button className="btn-primary" disabled={!can('settings_general', 'update') || save.isPending} onClick={() => save.mutate({ method: 'put', url: '/api/settings', body: s })}>{save.isPending ? <Spinner /> : <Save className="h-4 w-4" />} Save Changes</button>
      </div>
      {q.isLoading ? <div className="py-10 text-center"><Spinner className="inline h-5 w-5" /></div> : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card p-5 space-y-4">
            <h3 className="section-title">Branding & locale</h3>
            <Field label="Application Name"><TextInput value={s.appName ?? ''} onChange={(e) => set('appName', e.target.value)} /></Field>
            <Field label="Default Theme" hint="Users can still switch from the top bar"><div className="flex gap-2">{THEMES.map((t) => <button key={t.key} type="button" onClick={() => set('themeMode', t.key)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${s.themeMode === t.key ? 'border-primary bg-primary/5 text-primary' : 'border-line text-gray-600 hover:bg-gray-50'}`}><span className="h-4 w-4 rounded-full border border-line" style={{ background: t.swatch }} />{t.label}</button>)}</div></Field>
            <Field label="Primary Color" hint="Also change `primary` in apps/web/tailwind.config.js for the compiled theme"><div className="flex items-center gap-2"><input type="color" value={s.primaryColor ?? '#006CB8'} onChange={(e) => set('primaryColor', e.target.value)} className="h-10 w-14 rounded border border-line" /><TextInput value={s.primaryColor ?? ''} onChange={(e) => set('primaryColor', e.target.value)} className="w-[140px] font-mono" /></div></Field>
            <Field label="Date Format"><Select value={s.dateFormat} onChange={(v) => set('dateFormat', v)} placeholder="" options={['dd-MM-yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'].map((v) => ({ value: v, label: v }))} /></Field>
            <Field label="Time Format"><Select value={s.timeFormat} onChange={(v) => set('timeFormat', v)} placeholder="" options={[{ value: 'hh:mm tt', label: '12 hours' }, { value: 'HH:mm', label: '24 hours' }]} /></Field>
            <Field label="Currency"><TextInput value={s.currency ?? ''} onChange={(e) => set('currency', e.target.value)} className="w-[120px]" /></Field>
            <Field label="Number Format"><Select value={s.numberFormat} onChange={(v) => set('numberFormat', v)} placeholder="" options={[{ value: 'en-IN', label: 'Indian (12,34,567.89)' }, { value: 'en-US', label: 'International (1,234,567.89)' }, { value: 'de-DE', label: 'European (1.234.567,89)' }]} /></Field>
          </div>
          <div className="card p-5 space-y-4">
            <h3 className="section-title">Security & users</h3>
            <Field label="Session Length (hours)"><TextInput type="number" min={1} max={168} value={s.sessionHours ?? 12} onChange={(e) => set('sessionHours', Number(e.target.value))} className="w-[120px]" /></Field>
            <Field label="Minimum Password Length"><TextInput type="number" min={4} max={64} value={s.passwordMinLength ?? 6} onChange={(e) => set('passwordMinLength', Number(e.target.value))} className="w-[120px]" /></Field>
            <Switch checked={!!s.requireCompanyOnUsers} onChange={(v) => set('requireCompanyOnUsers', v)} label="Users must be assigned at least one company" />
            <Switch checked={!!s.allowSelfSignup} onChange={(v) => set('allowSelfSignup', v)} label="Allow self sign-up (requires a signup route)" />
          </div>
        </div>
      )}
    </>
  );
}
