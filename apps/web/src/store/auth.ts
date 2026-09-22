import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { hasPermission, type PermissionAction, type PermissionGrants } from '@erp/shared';

const PERSIST_KEY = 'erp-auth';
const REMEMBER_KEY = 'erp-auth-remember';

const quiet = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback; // private mode / blocked storage — stay signed in for this tab only
  }
};

/**
 * The choice is per tab: a tab that signed in keeps its own answer, so a second window
 * signing in with the box ticked can never promote this tab's session to disk. The
 * browser-wide copy only answers for tabs that never chose — a session restored from disk.
 */
const isRemembered = () => {
  const tab = quiet(() => sessionStorage.getItem(REMEMBER_KEY), null);
  return (tab ?? quiet(() => localStorage.getItem(REMEMBER_KEY), null)) !== 'false';
};

/**
 * "Remember me" on  → the session survives a browser restart (localStorage).
 * "Remember me" off → it dies with the tab (sessionStorage).
 *
 * Tokens live in exactly one of the two. Signing in with the box unchecked drops the
 * remembered copy, which also ends a remembered session in another window — deliberate:
 * "don't keep me signed in on this machine" outranks the convenience of that window.
 */
export function setRememberMe(remember: boolean) {
  quiet(() => sessionStorage.setItem(REMEMBER_KEY, String(remember)), undefined);
  quiet(() => localStorage.setItem(REMEMBER_KEY, String(remember)), undefined);
  quiet(() => (remember ? sessionStorage : localStorage).removeItem(PERSIST_KEY), undefined);
}

const authStorage = {
  getItem: (name: string) => quiet(() => sessionStorage.getItem(name) ?? localStorage.getItem(name), null),
  setItem: (name: string, value: string) => quiet(() => (isRemembered() ? localStorage : sessionStorage).setItem(name, value), undefined),
  removeItem: (name: string) =>
    quiet(() => {
      localStorage.removeItem(name);
      sessionStorage.removeItem(name);
    }, undefined),
};

export interface AuthUser {
  id: string;
  tenantId: string;
  tenantName?: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  mobile?: string | null;
  avatarUrl?: string | null;
  roleId: string;
  roleKey: string | null;
  roleName: string;
  isSuperAdmin: boolean;
  grants: PermissionGrants;
  companyIds: string[];
  branchIds: string[];
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setTokens: (access: string, refresh: string | null, user: AuthUser) => void;
  setUser: (u: AuthUser) => void;
  logout: () => void;
  /** RBAC check used by nav, buttons and routes */
  can: (subModule: string, action?: PermissionAction) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setTokens: (accessToken, refreshToken, user) => set({ accessToken, refreshToken: refreshToken ?? get().refreshToken, user }),
      setUser: (user) => set({ user }),
      logout: () => set({ accessToken: null, refreshToken: null, user: null }),
      can: (sub, action = 'read') => {
        const u = get().user;
        if (!u) return false;
        if (u.isSuperAdmin) return true;
        return hasPermission(u.grants, sub, action);
      },
    }),
    { name: PERSIST_KEY, storage: createJSONStorage(() => authStorage) },
  ),
);
