// ---------------------------------------------------------------------------
// Permission catalog — the single source of truth for RBAC.
//
// A permission is `<subModule>` × `<action>`. Roles hold a map
// { [subModule]: action[] }; users may additionally get per-user overrides.
// `super_admin` role bypasses everything.
//
// To add a module: push entries into PERMISSIONS (or call registerPermissions
// from your feature package) and reference the sub-module key in nav.ts and in
// app.requirePermission('<key>', '<action>') on the API.
// ---------------------------------------------------------------------------

export type PermissionAction = 'read' | 'create' | 'update' | 'delete';
export const PERMISSION_ACTIONS: PermissionAction[] = ['read', 'create', 'update', 'delete'];

export interface PermissionDef {
  /** unique key, e.g. `admin_users` */
  name: string;
  displayName: string;
  /** grouping shown as tabs in the permission matrix */
  module: string;
  /** actions that make sense for this sub-module (default: all four) */
  actions?: PermissionAction[];
}

export const PERMISSION_MODULE_LABELS: Record<string, string> = {
  admin: 'Administration',
  settings: 'Settings',
  sample: 'Sample Module',
};

export const PERMISSIONS: PermissionDef[] = [
  // Administration
  { name: 'admin_companies', displayName: 'Companies', module: 'admin' },
  { name: 'admin_branches', displayName: 'Branches', module: 'admin' },
  { name: 'admin_users', displayName: 'Users', module: 'admin' },
  { name: 'admin_roles', displayName: 'Roles & Permissions', module: 'admin' },
  { name: 'admin_activity_logs', displayName: 'Activity Logs', module: 'admin', actions: ['read'] },
  // Settings
  { name: 'settings_general', displayName: 'General Settings', module: 'settings', actions: ['read', 'update'] },
  { name: 'settings_custom_fields', displayName: 'Custom Fields', module: 'settings' },
  // Sample module — delete once you have real ones
  { name: 'sample_categories', displayName: 'Categories', module: 'sample' },
];

/** Feature packages can extend the catalog at startup (both API and web import the same shared package). */
export function registerPermissions(defs: PermissionDef[], moduleLabels: Record<string, string> = {}) {
  for (const d of defs) if (!PERMISSIONS.some((p) => p.name === d.name)) PERMISSIONS.push(d);
  Object.assign(PERMISSION_MODULE_LABELS, moduleLabels);
}

export type PermissionGrants = Record<string, PermissionAction[]>;

export function allPermissions(): PermissionGrants {
  return Object.fromEntries(PERMISSIONS.map((p) => [p.name, p.actions ?? [...PERMISSION_ACTIONS]]));
}

/** Effective grants = role grants merged with per-user overrides (union). */
export function mergeGrants(...sources: (PermissionGrants | null | undefined)[]): PermissionGrants {
  const out: PermissionGrants = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, actions] of Object.entries(src)) out[k] = Array.from(new Set([...(out[k] ?? []), ...actions]));
  }
  return out;
}

export function hasPermission(grants: PermissionGrants | undefined, subModule: string, action: PermissionAction = 'read') {
  return !!grants?.[subModule]?.includes(action);
}

/** System role keys seeded for every tenant. */
export const SYSTEM_ROLES = {
  super_admin: { name: 'Super Admin', description: 'Full access to everything, cannot be restricted' },
  admin: { name: 'Admin', description: 'Manage users, roles and settings' },
  manager: { name: 'Manager', description: 'Create and update business data' },
  user: { name: 'User', description: 'Read-only access' },
} as const;
export type SystemRoleKey = keyof typeof SYSTEM_ROLES;

/** Default grants for the seeded roles (super_admin bypasses checks entirely). */
export function defaultRoleGrants(key: SystemRoleKey): PermissionGrants {
  const all = allPermissions();
  switch (key) {
    case 'super_admin':
    case 'admin':
      return all;
    case 'manager':
      return Object.fromEntries(Object.entries(all).map(([k, a]) => [k, k.startsWith('admin_') ? ['read'] : a.filter((x) => x !== 'delete')]));
    case 'user':
      return Object.fromEntries(Object.keys(all).map((k) => [k, ['read']]));
  }
}
