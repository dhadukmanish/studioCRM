import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { Toaster } from '@/lib/toast';
import { Spinner } from '@/components/ui';
import AppShell from '@/components/layout/AppShell';
import Login from '@/pages/auth/Login';
import { ComingSoon, Dashboard, NotFound } from '@/pages/misc';

// Lazy pages — each becomes its own chunk.
const SettingsLayout = lazy(() => import('@/pages/settings/SettingsLayout'));
const SettingsHub = lazy(() => import('@/pages/settings/SettingsLayout').then((m) => ({ default: m.SettingsHub })));
const CompaniesPage = lazy(() => import('@/pages/settings/OrgPages').then((m) => ({ default: m.CompaniesPage })));
const BranchesPage = lazy(() => import('@/pages/settings/OrgPages').then((m) => ({ default: m.BranchesPage })));
const UsersPage = lazy(() => import('@/pages/settings/UsersPage'));
const RolesPage = lazy(() => import('@/pages/settings/RolesPage'));
const ActivityLogsPage = lazy(() => import('@/pages/settings/ActivityLogsPage'));
const CustomFieldsPage = lazy(() => import('@/pages/settings/CustomFieldsPage'));
const GeneralSettingsPage = lazy(() => import('@/pages/settings/GeneralSettingsPage'));
const ProfilePage = lazy(() => import('@/pages/account/ProfilePage'));
const ItemsPage = lazy(() => import('@/pages/masters/ItemsPage'));
const SubItemsPage = lazy(() => import('@/pages/masters/SubItemsPage'));
const AccountGroupsPage = lazy(() => import('@/pages/masters/AccountGroupsPage'));
const AccountsPage = lazy(() => import('@/pages/masters/AccountsPage'));
const BooksPage = lazy(() => import('@/pages/masters/BooksPage'));

/** Redirects to /signin when logged out. */
function Protected() {
  const token = useAuthStore((s) => s.accessToken);
  const loc = useLocation();
  if (!token) return <Navigate to={`/signin?callbackUrl=${encodeURIComponent(loc.pathname)}`} replace />;
  return <Outlet />;
}

/** Route-level RBAC guard: <Guard permission="admin_users"><UsersPage/></Guard> */
export function Guard({ permission, children }: { permission: string; children: ReactNode }) {
  const can = useAuthStore((s) => s.can);
  if (!can(permission)) return <Forbidden />;
  return <>{children}</>;
}
const Forbidden = () => (
  <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
    <div className="font-heading text-[48px] font-semibold text-gray-200">403</div>
    <p className="text-[15px] text-gray-600">You don't have permission to view this page.</p>
  </div>
);
const Fallback = () => <div className="flex justify-center py-20"><Spinner className="h-6 w-6 text-primary" /></div>;

export default function App() {
  return (
    <>
      <Toaster />
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/signin" element={<Login />} />
          <Route element={<Protected />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/profile" element={<ProfilePage />} />
              {/* ---- Masters ---- */}
              <Route path="/modules/masters/items" element={<Guard permission="masters_items"><ItemsPage /></Guard>} />
              <Route path="/modules/masters/sub-items" element={<Guard permission="masters_sub_items"><SubItemsPage /></Guard>} />
              <Route path="/modules/masters/account-groups" element={<Guard permission="masters_account_groups"><AccountGroupsPage /></Guard>} />
              <Route path="/modules/masters/accounts" element={<Guard permission="masters_accounts"><AccountsPage /></Guard>} />
              <Route path="/modules/masters/books" element={<Guard permission="masters_books"><BooksPage /></Guard>} />
              {/* ---- Settings ---- */}
              <Route path="/modules/settings" element={<SettingsHub />} />
              <Route path="/modules/settings" element={<SettingsLayout />}>
                <Route path="companies" element={<Guard permission="admin_companies"><CompaniesPage /></Guard>} />
                <Route path="branches" element={<Guard permission="admin_branches"><BranchesPage /></Guard>} />
                <Route path="users" element={<Guard permission="admin_users"><UsersPage /></Guard>} />
                <Route path="roles" element={<Guard permission="admin_roles"><RolesPage /></Guard>} />
                <Route path="activity-logs" element={<Guard permission="admin_activity_logs"><ActivityLogsPage /></Guard>} />
                <Route path="custom-fields" element={<Guard permission="settings_custom_fields"><CustomFieldsPage /></Guard>} />
                <Route path="general" element={<Guard permission="settings_general"><GeneralSettingsPage /></Guard>} />
                <Route path="*" element={<ComingSoon />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
