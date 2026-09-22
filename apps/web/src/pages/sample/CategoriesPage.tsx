import { MasterPage, type MasterConfig } from '@/components/data/MasterPage';
import { CustomFieldInputs } from '@/components/data/CustomFieldInputs';
import { Badge } from '@/components/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * SAMPLE MODULE PAGE — a full CRUD screen in ~40 lines.
 * Copy this file, change `url`, `permission`, `columns` and `fields`.
 */
export default function CategoriesPage() {
  const all = useQuery({ queryKey: ['categories', 'all'], queryFn: () => api.get<{ rows: any[] }>('/api/sample/categories?limit=500'), staleTime: 30_000 });
  const cfg: MasterConfig = {
    title: 'Categories',
    label: 'Category',
    url: '/api/sample/categories',
    permission: 'sample_categories',
    queryKey: 'categories',
    columns: [
      { key: 'name', header: 'Name', locked: true, render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
      { key: 'code', header: 'Code', render: (r) => r.code || '-' },
      { key: 'parentId', header: 'Parent', render: (r) => all.data?.rows.find((c) => c.id === r.parentId)?.name ?? '-' },
      { key: 'description', header: 'Description', render: (r) => r.description || '-' },
      { key: 'isActive', header: 'Status', render: (r) => (r.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>) },
    ],
    defaults: { name: '', code: '', parentId: '', description: '', isActive: true, customFields: {} },
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'code', label: 'Code' },
      { name: 'parentId', label: 'Parent Category', type: 'combobox', span: 2, options: () => (all.data?.rows ?? []).map((c) => ({ value: c.id, label: c.name })) },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'isActive', label: 'Active', type: 'switch' },
      { name: 'customFields', label: 'Custom Fields', type: 'custom', span: 2, render: (form) => <CustomFieldInputs moduleName="categories" value={form.watch('customFields') ?? {}} onChange={(v) => form.setValue('customFields', v)} /> },
    ],
    toForm: (r) => ({ ...r, code: r.code ?? '', parentId: r.parentId ?? '', description: r.description ?? '', customFields: r.customFields ?? {} }),
    toBody: (v) => ({ ...v, parentId: v.parentId || null }),
    invalidate: ['categories'],
    filterFields: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'isActive', label: 'Active', type: 'boolean' }, { key: 'createdAt', label: 'Created At', type: 'date' }],
  };
  return <MasterPage cfg={cfg} />;
}
