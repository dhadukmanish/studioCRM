import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { platformLoginSchema } from '@erp/shared';
import { ApiError } from '@/lib/api';
import { platformApi } from '@/lib/platformApi';
import { usePlatformAuth, type PlatformAdmin } from '@/store/platformAuth';
import { Field, Spinner } from '@/components/ui';
import { checkWith } from './queries';

export const PLATFORM_NAME = 'StudioCRM Platform';

export default function PlatformSignIn() {
  const { token, setSession } = usePlatformAuth();
  const nav = useNavigate();
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({ defaultValues: { email: '', password: '' } });
  if (token) return <Navigate to="/platform" replace />;

  const submit = handleSubmit(async (v) => {
    setErr('');
    const body = checkWith(platformLoginSchema, v, setError as never);
    if (!body) return;
    try {
      const r = await platformApi.post<{ accessToken: string; admin: PlatformAdmin }>('/api/platform/auth/login', body);
      setSession(r.accessToken, r.admin);
      nav('/platform', { replace: true });
    } catch (e) {
      // 401 wrong credentials, 429 AUTH_006 too many attempts — the server's message says which.
      setErr(e instanceof ApiError ? e.message : 'Unable to sign in');
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><ShieldCheck className="h-5 w-5" strokeWidth={1.5} /></span>
          <span className="font-heading text-[18px] font-semibold text-gray-900">{PLATFORM_NAME}</span>
        </div>
        <div className="card p-7">
          <h1 className="text-[18px] font-semibold text-gray-900">Sign in</h1>
          <p className="mt-1 text-[13px] text-gray-500">For the StudioCRM provider team only. Studios sign in on their own address.</p>
          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <Field label="Email" required error={errors.email?.message}>
              <input {...register('email')} type="email" autoComplete="username" autoFocus className="input" />
            </Field>
            <Field label="Password" required error={errors.password?.message}>
              <div className="relative">
                <input {...register('password')} type={show ? 'text' : 'password'} autoComplete="current-password" className="input pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition hover:text-gray-700">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{err}</p>}
            <button type="submit" disabled={isSubmitting} className="btn-primary btn-lg w-full">{isSubmitting && <Spinner />} Sign in</button>
          </form>
        </div>
      </div>
    </div>
  );
}
