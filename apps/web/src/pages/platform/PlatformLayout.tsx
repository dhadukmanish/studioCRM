import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { platformChangePasswordSchema } from '@erp/shared';
import { Dropdown, Field, Modal, Spinner, TextInput } from '@/components/ui';
import { cx } from '@/lib/format';
import { usePlatformAuth } from '@/store/platformAuth';
import { applyPlatformErrors, checkWith, usePlatformMe, usePlatformSave } from './queries';
import { PLATFORM_NAME } from './PlatformSignIn';

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const blank = { currentPassword: '', newPassword: '' };
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm({ defaultValues: blank });
  useEffect(() => {
    if (open) reset(blank);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = usePlatformSave({ onSuccess: onClose });
  const submit = handleSubmit((v) => {
    const body = checkWith(platformChangePasswordSchema, v, setError as never);
    if (body) save.mutate({ method: 'put', url: '/api/platform/auth/change-password', body }, { onError: (e) => applyPlatformErrors(e, setError as never) });
  });
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Change password" footer={<><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button type="submit" form="platform-password" className="btn-primary" disabled={save.isPending}>{save.isPending && <Spinner />} Change password</button></>}>
      <form id="platform-password" onSubmit={submit} className="grid gap-4" noValidate>
        <Field label="Current password" required error={errors.currentPassword?.message}><TextInput type="password" autoComplete="current-password" {...register('currentPassword')} /></Field>
        <Field label="New password" required error={errors.newPassword?.message} hint="At least 8 characters"><TextInput type="password" autoComplete="new-password" {...register('newPassword')} /></Field>
      </form>
    </Modal>
  );
}

const navCls = ({ isActive }: { isActive: boolean }) =>
  cx('flex h-14 items-center border-b-2 px-2 text-[13.5px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-on-topbar/60 sm:px-3', isActive ? 'border-on-topbar text-on-topbar' : 'border-transparent text-on-topbar/75 hover:text-on-topbar');

/** The platform panel's frame: its own top bar and session — never the studio AppShell. */
export default function PlatformLayout() {
  const { token, admin, setAdmin, logout } = usePlatformAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [pwd, setPwd] = useState(false);
  // Confirms the stored token is still good and keeps the admin's name current; a 401 here (or on
  // any call) clears the session, which re-renders this into the redirect below.
  const me = usePlatformMe(!!token);
  useEffect(() => {
    if (me.data) setAdmin(me.data);
  }, [me.data, setAdmin]);
  if (!token) return <Navigate to="/platform/signin" replace state={{ from: loc.pathname }} />;

  const signOut = () => {
    logout();
    qc.removeQueries({ queryKey: ['platform'] });
    nav('/platform/signin', { replace: true });
  };
  const studiosActive = loc.pathname === '/platform' || loc.pathname.startsWith('/platform/studios');
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-topbar px-3 text-on-topbar sm:gap-4 sm:px-5">
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="h-5 w-5 shrink-0" strokeWidth={1.5} />
          <span className="hidden truncate font-heading text-[15px] font-semibold sm:inline">{PLATFORM_NAME}</span>
        </span>
        <nav aria-label="Platform" className="flex items-center">
          <NavLink to="/platform" end className={() => navCls({ isActive: studiosActive })}>Studios</NavLink>
          <NavLink to="/platform/plans" className={navCls}>Plans</NavLink>
        </nav>
        <div className="ml-auto">
          <Dropdown
            items={[
              { label: 'Change password', icon: <KeyRound className="h-4 w-4" />, onClick: () => setPwd(true) },
              { divider: true, label: '' },
              { label: 'Sign out', icon: <LogOut className="h-4 w-4" />, onClick: signOut, danger: true },
            ]}
            trigger={
              <button type="button" aria-haspopup="menu" className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] font-medium text-on-topbar transition hover:bg-topbar-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-on-topbar/60">
                <span className="max-w-[160px] truncate">{admin?.name ?? 'Account'}</span>
                <ChevronDown className="h-4 w-4" />
              </button>
            }
          />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] min-w-0 flex-1 px-4 py-4 sm:px-6">
        <Outlet />
      </main>
      <ChangePasswordDialog open={pwd} onClose={() => setPwd(false)} />
    </div>
  );
}
