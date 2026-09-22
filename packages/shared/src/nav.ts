// ---------------------------------------------------------------------------
// Sidebar + settings navigation. Items are hidden automatically when the user
// lacks `permission` (read). Icons are lucide names registered in
// apps/web/src/lib/icons.tsx.
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  href?: string;
  icon?: string;
  permission?: string;
  children?: NavItem[];
}
export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' }],
  },
  {
    title: 'Masters',
    items: [
      { label: 'Item Master', href: '/modules/masters/items', icon: 'Package', permission: 'masters_items' },
      { label: 'Sub Item Master', href: '/modules/masters/sub-items', icon: 'Boxes', permission: 'masters_sub_items' },
    ],
  },
  {
    title: 'Sample Module',
    items: [{ label: 'Categories', href: '/modules/sample/categories', icon: 'Tags', permission: 'sample_categories' }],
  },
];

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
    ],
  },
];
