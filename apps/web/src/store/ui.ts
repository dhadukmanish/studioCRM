import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applyTheme, type ThemePref } from '@/lib/theme';

interface UiState {
  sidebarCollapsed: boolean;
  mobileOpen: boolean;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  toggleSidebar: () => void;
  setMobileOpen: (v: boolean) => void;
}
export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      mobileOpen: false,
      theme: 'system',
      setTheme: (theme) => { applyTheme(theme); set({ theme }); },
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setMobileOpen: (v) => set({ mobileOpen: v }),
    }),
    { name: 'erp-ui', partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, theme: s.theme }) },
  ),
);
