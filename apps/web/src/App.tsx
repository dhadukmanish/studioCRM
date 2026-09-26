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
const AppointmentsPage = lazy(() => import('@/pages/appointments/AppointmentsPage'));
const BillsPage = lazy(() => import('@/pages/billing/BillsPage'));
const BillFormPage = lazy(() => import('@/pages/billing/BillFormPage'));
const InvoicePreviewPage = lazy(() => import('@/pages/billing/InvoicePreviewPage'));
const ReceiptsPage = lazy(() => import('@/pages/receipts/ReceiptsPage'));
const ReceiptFormPage = lazy(() => import('@/pages/receipts/ReceiptFormPage'));
const ReceiptDetailPage = lazy(() => import('@/pages/receipts/ReceiptDetailPage'));
const ReceivablesPage = lazy(() => import('@/pages/reports/ReceivablesPage'));
const ReceivableCustomerPage = lazy(() => import('@/pages/reports/ReceivableCustomerPage'));
const InvoiceTemplatesPage = lazy(() => import('@/pages/settings/invoice-templates/InvoiceTemplatesPage'));
const InvoiceTemplateDesignerPage = lazy(() => import('@/pages/settings/invoice-templates/InvoiceTemplateDesignerPage'));

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
              {/* ---- Operations ---- */}
              <Route path="/modules/appointments" element={<Guard permission="operations_appointments"><AppointmentsPage /></Guard>} />
              {/* "new" is declared before ":id" so the literal path can never be read as a bill id. */}
              <Route path="/modules/billing" element={<Guard permission="operations_billing"><BillsPage /></Guard>} />
              <Route path="/modules/billing/new" element={<Guard permission="operations_billing"><BillFormPage /></Guard>} />
              <Route path="/modules/billing/:id" element={<Guard permission="operations_billing"><BillFormPage /></Guard>} />
              <Route path="/modules/billing/:id/invoice" element={<Guard permission="operations_billing"><InvoicePreviewPage /></Guard>} />
              {/* Receipts are created and cancelled, never edited — so ':id' is a read-only detail. The form checks create itself. */}
              <Route path="/modules/receipts" element={<Guard permission="operations_receipts"><ReceiptsPage /></Guard>} />
              <Route path="/modules/receipts/new" element={<Guard permission="operations_receipts"><ReceiptFormPage /></Guard>} />
              <Route path="/modules/receipts/:id" element={<Guard permission="operations_receipts"><ReceiptDetailPage /></Guard>} />
              {/* ---- Reports ---- */}
              <Route path="/modules/reports/receivables" element={<Guard permission="reports_receivables"><ReceivablesPage /></Guard>} />
              <Route path="/modules/reports/receivables/customers/:key" element={<Guard permission="reports_receivables"><ReceivableCustomerPage /></Guard>} />
              {/* ---- Settings ---- */}
              <Route path="/modules/settings" element={<SettingsHub />} />
              {/* The designer needs the full width, so it sits outside the settings sub-nav. */}
              <Route path="/modules/settings/invoice-templates/:id" element={<Guard permission="settings_invoice_templates"><InvoiceTemplateDesignerPage /></Guard>} />
              <Route path="/modules/settings" element={<SettingsLayout />}>
                <Route path="companies" element={<Guard permission="admin_companies"><CompaniesPage /></Guard>} />
                <Route path="branches" element={<Guard permission="admin_branches"><BranchesPage /></Guard>} />
                <Route path="users" element={<Guard permission="admin_users"><UsersPage /></Guard>} />
                <Route path="roles" element={<Guard permission="admin_roles"><RolesPage /></Guard>} />
                <Route path="activity-logs" element={<Guard permission="admin_activity_logs"><ActivityLogsPage /></Guard>} />
                <Route path="custom-fields" element={<Guard permission="settings_custom_fields"><CustomFieldsPage /></Guard>} />
                <Route path="general" element={<Guard permission="settings_general"><GeneralSettingsPage /></Guard>} />
                <Route path="invoice-templates" element={<Guard permission="settings_invoice_templates"><InvoiceTemplatesPage /></Guard>} />
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
