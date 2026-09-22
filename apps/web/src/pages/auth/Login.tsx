import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Boxes } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Field, Spinner, Checkbox } from '@/components/ui';

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
      setTokens(r.accessToken, r.refreshToken, r.user);
      nav(callback, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Unable to sign in');
    }
  });

  return (
    <div className="flex min-h-screen bg-page">
      <div className="hidden lg:flex w-1/2 flex-col justify-between bg-gradient-to-br from-primary-dark via-primary to-[#3B9BDD] p-12 text-white">
        <div className="flex items-center gap-2 font-heading text-[22px] font-semibold"><Boxes className="h-7 w-7" /> {import.meta.env.VITE_APP_NAME ?? 'ERP'}</div>
        <div>
          <h1 className="font-heading text-[36px] font-semibold leading-tight text-white">Run your business,<br />one workspace.</h1>
          <p className="mt-4 max-w-md text-[15px] text-white/80">Multi-company, role-based access, custom fields and audit trail — ready on day one.</p>
        </div>
        <p className="text-[12px] text-white/60">© {new Date().getFullYear()} {import.meta.env.VITE_APP_NAME ?? 'ERP'}</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[420px]">
          <div className="mb-8 lg:hidden flex items-center gap-2 font-heading text-[20px] font-semibold text-gray-900"><Boxes className="h-6 w-6 text-primary" /> {import.meta.env.VITE_APP_NAME ?? 'ERP'}</div>
          <h2 className="text-[26px] font-semibold text-gray-900">Welcome back! Please sign in to continue.</h2>
          <p className="mt-2 text-[14px] text-gray-500">Enter your email or username and password to access your account.</p>
          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field label="Email or Username" required error={errors.email?.message}>
              <input {...register('email', { required: 'Email or username is required' })} autoComplete="username" placeholder="Enter your email or username" className="input" />
            </Field>
            <Field label="Password" required error={errors.password?.message}>
              <div className="relative">
                <input {...register('password', { required: 'Password is required' })} type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" className="input pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
            </Field>
            <div className="flex items-center justify-between">
              <Checkbox checked={remember} onChange={setRemember} label="Remember Me" />
              <a className="link text-[13px]" href="#">Forgot Password?</a>
            </div>
            {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{err}</p>}
            <button type="submit" disabled={isSubmitting} className="btn-primary btn-lg w-full">{isSubmitting && <Spinner />} Sign in</button>
          </form>
        </div>
      </div>
    </div>
  );
}
