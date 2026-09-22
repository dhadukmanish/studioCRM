import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Boxes } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { setRememberMe, useAuthStore } from '@/store/auth';
import { Field, Spinner, Checkbox } from '@/components/ui';

const APP_NAME = import.meta.env.VITE_APP_NAME ?? 'StudioCRM';

export default function Login() {
  const { accessToken, setTokens } = useAuthStore();
  const nav = useNavigate();
  const loc = useLocation();
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string; password: string }>();
  if (accessToken) return <Navigate to="/dashboard" replace />;
  const callback = new URLSearchParams(loc.search).get('callbackUrl') || '/dashboard';

  const submit = handleSubmit(async (v) => {
    setErr('');
    try {
      const r = await api.post<{ accessToken: string; refreshToken: string; user: any }>('/api/auth/login', v);
      setRememberMe(remember);
      setTokens(r.accessToken, r.refreshToken, r.user);
      nav(callback, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Unable to sign in');
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><Boxes className="h-5 w-5" /></span>
          <span className="font-heading text-[18px] font-semibold text-gray-900">{APP_NAME}</span>
        </div>

        <div className="card p-7">
          <h1 className="text-[18px] font-semibold text-gray-900">Sign in</h1>
          <p className="mt-1 text-[13px] text-gray-500">Use your {APP_NAME} account to continue.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="Email or username" required error={errors.email?.message}>
              <input
                {...register('email', { required: 'Email or username is required' })}
                autoComplete="username"
                autoFocus
                placeholder="you@studio.com"
                className="input"
              />
            </Field>

            <Field label="Password" required error={errors.password?.message}>
              <div className="relative">
                <input
                  {...register('password', { required: 'Password is required' })}
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="input pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition hover:text-gray-700"
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>

            <Checkbox checked={remember} onChange={setRemember} label="Remember me" className="text-[13px]" />

            {err && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{err}</p>
            )}

            <button type="submit" disabled={isSubmitting} className="btn-primary btn-lg w-full">
              {isSubmitting && <Spinner />} Sign in
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-[12px] text-gray-400">© {new Date().getFullYear()} {APP_NAME}</p>
      </div>
    </div>
  );
}
