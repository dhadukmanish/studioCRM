// ---------------------------------------------------------------------------
// Sidebar + settings navigation. The sidebar shows one icon per group; the open
// group's pages are tabs above the page (AppShell). Items are hidden
// automatically when the user lacks `permission` (read), and a group with no
// visible item is hidden. Icons are lucide names registered in
// apps/web/src/lib/icons.tsx.
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  href: string;
  icon?: string;
  permission?: string;
}
export interface NavSection {
  title: string;
  icon: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: 'Dashboard',
    icon: 'LayoutDashboard',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' }],
  },
  {
    title: 'Work',
    icon: 'ListTodo',
    items: [
      { label: "Today's Work", href: '/modules/work', icon: 'ListTodo', permission: 'operations_work' },
      { label: 'Appointments', href: '/modules/appointments', icon: 'CalendarClock', permission: 'operations_appointments' },
    ],
  },
  {
    title: 'Billing',
    icon: 'ReceiptText',
    items: [
      { label: 'Bills', href: '/modules/billing', icon: 'ReceiptText', permission: 'operations_billing' },
      { label: 'Receipts', href: '/modules/receipts', icon: 'HandCoins', permission: 'operations_receipts' },
    ],
  },
  {
    title: 'Reports',
    icon: 'ChartColumn',
    items: [
      { label: 'Bill Summary', href: '/modules/reports/bills', icon: 'FileSpreadsheet', permission: 'reports_bills' },
      { label: 'Receivables', href: '/modules/reports/receivables', icon: 'ChartColumn', permission: 'reports_receivables' },
      { label: 'Delivery', href: '/modules/reports/delivery', icon: 'PackageCheck', permission: 'operations_work' },
      { label: 'Appointments', href: '/modules/reports/appointments', icon: 'CalendarRange', permission: 'operations_appointments' },
    ],
  },
  {
    title: 'Masters',
    icon: 'Database',
    items: [
      { label: 'Items', href: '/modules/masters/items', icon: 'Package', permission: 'masters_items' },
      { label: 'Sub Items', href: '/modules/masters/sub-items', icon: 'Boxes', permission: 'masters_sub_items' },
      { label: 'Account Groups', href: '/modules/masters/account-groups', icon: 'Layers', permission: 'masters_account_groups' },
      { label: 'Accounts', href: '/modules/masters/accounts', icon: 'Wallet', permission: 'masters_accounts' },
      { label: 'Books', href: '/modules/masters/books', icon: 'BookText', permission: 'masters_books' },
    ],
  },
];

/** The group a path belongs to: the one with an item whose href is the path or a parent of it. */
export function navSectionFor(sections: NavSection[], pathname: string): NavSection | undefined {
  return sections.find((s) => s.items.some((it) => pathname === it.href || pathname.startsWith(it.href + '/')));
}

export interface SettingsGroup {
  title: string;
  icon: string;
  items: { label: string; href: string; permission?: string }[];
}
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'Organization',
    icon: 'Building2',
    items: [
      { label: 'Companies', href: '/modules/settings/companies', permission: 'admin_companies' },
      { label: 'Branches', href: '/modules/settings/branches', permission: 'admin_branches' },
    ],
  },
  {
    title: 'Users & Access',
    icon: 'UserCog',
    items: [
      { label: 'Users', href: '/modules/settings/users', permission: 'admin_users' },
      { label: 'Roles & Permissions', href: '/modules/settings/roles', permission: 'admin_roles' },
      { label: 'Activity Logs', href: '/modules/settings/activity-logs', permission: 'admin_activity_logs' },
    ],
  },
  {
    title: 'Customization',
    icon: 'SlidersHorizontal',
    items: [
      { label: 'General', href: '/modules/settings/general', permission: 'settings_general' },
      { label: 'Custom Fields', href: '/modules/settings/custom-fields', permission: 'settings_custom_fields' },
      { label: 'Print & Invoice', href: '/modules/settings/print-invoice', permission: 'settings_invoice_templates' },
      { label: 'Invoice Templates', href: '/modules/settings/invoice-templates', permission: 'settings_invoice_templates' },
    ],
  },
];
