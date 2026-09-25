import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MasterPage, type MasterConfig } from '@/components/data/MasterPage';
import { CustomFieldInputs } from '@/components/data/CustomFieldInputs';
import { Badge, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useCompanies } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';
import { CompanyLogoField } from './CompanyLogoField';

const COUNTRIES = [{ value: 'IN', label: 'India' }, { value: 'US', label: 'United States' }, { value: 'AE', label: 'United Arab Emirates' }, { value: 'GB', label: 'United Kingdom' }, { value: 'SG', label: 'Singapore' }];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'].map((t) => ({ value: t, label: t }));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => ({ value: String(i + 1), label: m }));

/* ============================ Companies ============================ */
export function CompaniesPage() {
  const fmt = useDateFormatters();

  const cfg: MasterConfig = {
    title: 'Companies', label: 'Company', url: '/api/admin/companies', permission: 'admin_companies', queryKey: 'companies', modalSize: 'lg',
    columns: [
      { key: 'name', header: 'Company', locked: true, render: (r) => <span className="flex items-center gap-2 font-medium text-gray-900">{r.name}{r.isDefault && <Badge color="blue">Default</Badge>}</span> },
      { key: 'legalName', header: 'Legal Name', render: (r) => r.legalName || '-' },
      { key: 'taxId', header: 'Tax ID', render: (r) => r.taxId || '-' },
      { key: 'countryCode', header: 'Country' },
      { key: 'currency', header: 'Currency' },
      { key: 'city', header: 'City', render: (r) => r.city || '-', hidden: true },
      { key: 'isActive', header: 'Status', render: (r) => (r.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>) },
      { key: 'createdAt', header: 'Created At', render: (r) => fmt.stampTime(r.createdAt), hidden: true },
    ],
    defaults: { name: '', legalName: '', countryCode: 'IN', taxId: '', email: '', phone: '', website: '', addressLine1: '', addressLine2: '', city: '', state: '', pincode: '', currency: 'INR', timeZone: 'Asia/Kolkata', fiscalYearStartMonth: '4', isActive: true, customFields: {} },
    fields: [
      { name: 'name', label: 'Company Name', required: true },
      { name: 'logo', label: 'Logo', type: 'custom', span: 2, render: (_form, row) => <CompanyLogoField key={row?.id ?? 'new'} companyId={row?.id} logoUpdatedAt={row?.logoUpdatedAt} /> },
      { name: 'legalName', label: 'Legal Name' },
      { name: 'countryCode', label: 'Country', type: 'select', required: true, options: COUNTRIES },
      { name: 'taxId', label: 'Tax ID (GSTIN / VAT)' },
      { name: 'email', label: 'Email' },
      { name: 'phone', label: 'Phone' },
      { name: 'website', label: 'Website', span: 2 },
      { name: 'addressLine1', label: 'Address Line 1', span: 2 },
      { name: 'addressLine2', label: 'Address Line 2', span: 2 },
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State' },
      { name: 'pincode', label: 'Pincode' },
      { name: 'currency', label: 'Currency', required: true, placeholder: 'INR' },
      { name: 'timeZone', label: 'Time Zone', type: 'select', required: true, options: TIMEZONES },
      { name: 'fiscalYearStartMonth', label: 'Fiscal Year Starts', type: 'select', options: MONTHS },
      { name: 'isActive', label: 'Active', type: 'switch' },
      { name: 'customFields', label: 'Custom Fields', type: 'custom', span: 2, render: (form) => <CustomFieldInputs moduleName="companies" value={form.watch('customFields') ?? {}} onChange={(v) => form.setValue('customFields', v)} /> },
    ],
    toForm: (r) => ({ ...r, legalName: r.legalName ?? '', taxId: r.taxId ?? '', email: r.email ?? '', phone: r.phone ?? '', website: r.website ?? '', addressLine1: r.addressLine1 ?? '', addressLine2: r.addressLine2 ?? '', city: r.city ?? '', state: r.state ?? '', pincode: r.pincode ?? '', fiscalYearStartMonth: String(r.fiscalYearStartMonth ?? 4), customFields: r.customFields ?? {} }),
    toBody: (v) => ({ ...v, fiscalYearStartMonth: Number(v.fiscalYearStartMonth) }),
    canDelete: (r) => !r.isDefault,
  };
  return <MasterPage cfg={cfg} />;
}

/* ============================ Branches ============================ */
export function BranchesPage() {
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState('');
  const all = useQuery({ queryKey: ['lookup', 'companies'], queryFn: () => api.get<any[]>('/api/common/lookups/companies'), staleTime: 60_000 });
  const cfg: MasterConfig = {
    title: 'Branches', label: 'Branch', url: '/api/admin/branches', permission: 'admin_branches', queryKey: 'branches', filters: { companyId },
    columns: [
      { key: 'name', header: 'Branch', locked: true, render: (r) => <span className="flex items-center gap-2 font-medium text-gray-900">{r.name}{r.isDefault && <Badge color="blue">Default</Badge>}</span> },
      { key: 'code', header: 'Code', render: (r) => r.code || '-' },
      { key: 'companyId', header: 'Company', render: (r) => all.data?.find((c) => c.id === r.companyId)?.name ?? '-' },
      { key: 'address', header: 'Address', render: (r) => r.address || '-' },
      { key: 'isActive', header: 'Status', render: (r) => (r.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>) },
    ],
    defaults: { companyId: '', name: '', code: '', address: '', isActive: true },
    fields: [
      { name: 'companyId', label: 'Company', type: 'select', required: true, span: 2, options: () => (companies.data ?? []).map((c) => ({ value: c.id, label: c.name })) },
      { name: 'name', label: 'Branch Name', required: true },
      { name: 'code', label: 'Code', placeholder: 'HO' },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'isActive', label: 'Active', type: 'switch' },
    ],
    toForm: (r) => ({ ...r, code: r.code ?? '', address: r.address ?? '' }),
    canDelete: (r) => !r.isDefault,
    toolbar: <Select size="sm" className="w-[200px]" value={companyId} onChange={setCompanyId} placeholder="All Companies" options={(companies.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />,
  };
  return <MasterPage key={companyId} cfg={cfg} />;
}
