import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * The platform panel's session — a different account, token and storage key from the studio
 * session (store/auth.ts), so signing in to one never signs in to or out of the other. There is
 * no refresh token: the 12-hour token simply expires and the next 401 ends the session.
 */
export interface PlatformAdmin {
  id: string;
  name: string;
  email: string;
}

interface PlatformAuthState {
  token: string | null;
  admin: PlatformAdmin | null;
  setSession: (token: string, admin: PlatformAdmin) => void;
  setAdmin: (admin: PlatformAdmin) => void;
  logout: () => void;
}

const quiet = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback; // private mode / blocked storage — stay signed in for this tab only
  }
};

const storage = {
  getItem: (name: string) => quiet(() => localStorage.getItem(name), null),
  setItem: (name: string, value: string) => quiet(() => localStorage.setItem(name, value), undefined),
  removeItem: (name: string) => quiet(() => localStorage.removeItem(name), undefined),
};

export const usePlatformAuth = create<PlatformAuthState>()(
  persist(
    (set) => ({
      token: null,
      admin: null,
      setSession: (token, admin) => set({ token, admin }),
      setAdmin: (admin) => set({ admin }),
      logout: () => set({ token: null, admin: null }),
    }),
    { name: 'erp-platform-auth', storage: createJSONStorage(() => storage) },
  ),
);
