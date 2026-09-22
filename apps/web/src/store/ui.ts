import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  mobileOpen: boolean;
  openGroups: Record<string, boolean>;
  toggleSidebar: () => void;
  setMobileOpen: (v: boolean) => void;
  toggleGroup: (k: string) => void;
}
export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      mobileOpen: false,
      openGroups: {},
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setMobileOpen: (v) => set({ mobileOpen: v }),
      toggleGroup: (k) => set({ openGroups: { ...get().openGroups, [k]: !get().openGroups[k] } }),
    }),
    { name: 'erp-ui', partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, openGroups: s.openGroups }) },
  ),
);
