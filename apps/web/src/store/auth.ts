import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { hasPermission, type PermissionAction, type PermissionGrants } from '@erp/shared';

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
    { name: 'erp-auth' },
  ),
);
