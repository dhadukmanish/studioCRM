import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Field, Spinner, TextInput, Badge } from '@/components/ui';
import { api } from '@/lib/api';
import { useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { PERMISSIONS } from '@erp/shared';

export default function ProfilePage() {
  const { user, setUser, logout } = useAuthStore();
  const nav = useNavigate();
  const profile = useForm<{ firstName: string; lastName: string; mobile: string }>({ defaultValues: { firstName: '', lastName: '', mobile: '' } });
  const pwd = useForm<{ currentPassword: string; newPassword: string; confirm: string }>();
  useEffect(() => { api.get<any>('/api/auth/me').then((u) => { setUser(u); profile.reset({ firstName: u.firstName ?? '', lastName: u.lastName ?? '', mobile: u.mobile ?? '' }); }).catch(() => {}); }, []); // eslint-disable-line
  const saveProfile = useSave({ invalidate: [], onSuccess: (u: any) => setUser({ ...user!, ...u }) });
  const savePwd = useSave({ invalidate: [], onSuccess: () => { logout(); nav('/signin'); } });
  const granted = user?.isSuperAdmin ? PERMISSIONS.map((p) => p.displayName) : PERMISSIONS.filter((p) => user?.grants[p.name]?.length).map((p) => `${p.displayName} (${user?.grants[p.name].join(', ')})`);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h2 className="text-[20px] font-semibold text-gray-900">My Profile</h2>
      <form onSubmit={profile.handleSubmit((v) => saveProfile.mutate({ method: 'put', url: '/api/auth/profile', body: v }))} className="card p-5">
        <div className="mb-4 flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-lighter text-[18px] font-semibold text-primary-dark">{(user?.name ?? '?').split(' ').map((s) => s[0]).slice(0, 2).join('')}</span>
          <div><div className="text-[16px] font-semibold text-gray-900">{user?.name}</div><div className="text-[13px] text-gray-500">{user?.email}</div><Badge color="blue" className="mt-1">{user?.roleName}</Badge></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="First Name" required><TextInput {...profile.register('firstName', { required: true })} /></Field>
          <Field label="Last Name" required><TextInput {...profile.register('lastName', { required: true })} /></Field>
          <Field label="Mobile"><TextInput {...profile.register('mobile')} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><button className="btn-primary" disabled={saveProfile.isPending}>{saveProfile.isPending && <Spinner />} Save Profile</button></div>
      </form>
      <form onSubmit={pwd.handleSubmit((v) => { if (v.newPassword !== v.confirm) { pwd.setError('confirm', { message: 'Passwords do not match' }); return; } savePwd.mutate({ method: 'put', url: '/api/auth/change-password', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } }); })} className="card p-5">
        <h3 className="mb-3 text-[15px] font-semibold text-gray-900">Change Password</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Current Password" required><TextInput type="password" autoComplete="current-password" {...pwd.register('currentPassword', { required: true })} /></Field>
          <Field label="New Password" required error={pwd.formState.errors.newPassword?.message}><TextInput type="password" autoComplete="new-password" {...pwd.register('newPassword', { required: true, minLength: { value: 6, message: 'Minimum 6 characters' } })} /></Field>
          <Field label="Confirm" required error={pwd.formState.errors.confirm?.message}><TextInput type="password" autoComplete="new-password" {...pwd.register('confirm', { required: true })} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><button className="btn-outline-primary" disabled={savePwd.isPending}>{savePwd.isPending && <Spinner />} Change Password</button></div>
      </form>
      <div className="card p-5">
        <h3 className="mb-2 text-[15px] font-semibold text-gray-900">My Permissions</h3>
        <p className="mb-3 text-[13px] text-gray-500">Role <b>{user?.roleName}</b>{user?.isSuperAdmin ? ' — full access' : ''}</p>
        <div className="flex flex-wrap gap-1.5">{granted.map((g) => <Badge key={g}>{g}</Badge>)}</div>
      </div>
    </div>
  );
}
