import { isIsoDate } from '@erp/shared';
import { Checkbox, Combobox, DateInput, Field, RadioGroup, Select, Switch, TextArea, TextInput } from '@/components/ui';
import { useCustomFields } from '@/lib/queries';

/** Renders a module's active custom fields bound to a `Record<string, any>` value. */
export function CustomFieldInputs({ moduleName, value, onChange, className }: { moduleName: string; value: Record<string, any>; onChange: (v: Record<string, any>) => void; className?: string }) {
  const { data: fields } = useCustomFields(moduleName);
  if (!fields?.length) return null;
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <div className={className ?? 'grid gap-4 sm:grid-cols-2'}>
      {fields.map((f: any) => {
        const v = value?.[f.fieldName] ?? f.defaultValue ?? '';
        const opts = (f.options ?? []).map((o: any) => ({ value: o.value, label: o.label ?? o.value }));
        const common = { key: f.id, label: f.fieldLabel, required: f.isRequired, hint: f.showTooltip ? f.tooltip : undefined };
        switch (f.fieldType) {
          case 'textarea':
          case 'rich_text':
            return <Field {...common} className="sm:col-span-2"><TextArea value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          case 'number':
          case 'decimal':
          case 'currency':
          case 'percent':
            return <Field {...common}><TextInput type="number" step="any" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value === '' ? null : Number(e.target.value))} /></Field>;
          case 'date':
            return <Field {...common}><DateInput value={v} readOnly={f.isReadOnly} onChange={(x) => set(f.fieldName, isIsoDate(x) ? x : null)} /></Field>;
          case 'datetime':
            return <Field {...common}><TextInput type="datetime-local" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          case 'time':
            return <Field {...common}><TextInput type="time" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          case 'checkbox':
          case 'boolean':
          case 'toggle':
            return <Field {...common} label={undefined}><div className="h-10 flex items-center">{f.fieldType === 'toggle' ? <Switch checked={!!v} onChange={(x) => set(f.fieldName, x)} label={f.fieldLabel} /> : <Checkbox checked={!!v} onChange={(x) => set(f.fieldName, x)} label={f.fieldLabel} />}</div></Field>;
          case 'select':
          case 'lookup':
            return <Field {...common}>{opts.length > 8 ? <Combobox value={v} onChange={(x) => set(f.fieldName, x)} options={opts} disabled={f.isReadOnly} /> : <Select value={v} onChange={(x) => set(f.fieldName, x)} options={opts} disabled={f.isReadOnly} />}</Field>;
          case 'multi_select':
          case 'checkbox_group':
          case 'tags':
            return <Field {...common}><Combobox multiple value={Array.isArray(v) ? v : []} onChange={(x) => set(f.fieldName, x)} options={opts} disabled={f.isReadOnly} onCreate={f.fieldType === 'tags' ? (t) => set(f.fieldName, [...(Array.isArray(v) ? v : []), t]) : undefined} /></Field>;
          case 'radio':
            return <Field {...common}><div className="h-10 flex items-center"><RadioGroup value={v} onChange={(x) => set(f.fieldName, x)} options={opts} name={f.fieldName} /></div></Field>;
          case 'email':
            return <Field {...common}><TextInput type="email" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          case 'url':
            return <Field {...common}><TextInput type="url" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          case 'phone':
            return <Field {...common}><TextInput type="tel" value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
          default:
            return <Field {...common}><TextInput value={v} readOnly={f.isReadOnly} onChange={(e) => set(f.fieldName, e.target.value)} /></Field>;
        }
      })}
    </div>
  );
}

/** Format a custom-field value for read-only display */
export function customFieldDisplay(f: any, v: any) {
  if (v == null || v === '') return '-';
  if (Array.isArray(v)) return v.map((x) => f.options?.find((o: any) => o.value === x)?.label ?? x).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return f.options?.find((o: any) => o.value === v)?.label ?? String(v);
}
