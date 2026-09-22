import { create } from 'zustand';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';

type Toast = { id: number; type: 'success' | 'error' | 'info'; message: string };
const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; remove: (id: number) => void }>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().remove(id), 4000);
  },
  remove: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}));

export const toast = {
  success: (message: string) => useToasts.getState().push({ type: 'success', message }),
  error: (message: string) => useToasts.getState().push({ type: 'error', message }),
  info: (message: string) => useToasts.getState().push({ type: 'info', message }),
};

export function Toaster() {
  const { toasts, remove } = useToasts();
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="card flex items-center gap-2 px-4 py-3 min-w-[260px] max-w-[380px] text-[14px] shadow-lg">
          {t.type === 'success' && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />}
          {t.type === 'error' && <XCircle className="h-4 w-4 text-red-600 shrink-0" />}
          {t.type === 'info' && <Info className="h-4 w-4 text-primary shrink-0" />}
          <span className="flex-1 text-gray-800">{t.message}</span>
          <button onClick={() => remove(t.id)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
