// ---------------------------------------------------------------------------
// Application-wide enums. Add your own domain enums here (or in a new file).
// ---------------------------------------------------------------------------

/** Kinds of custom fields supported by the custom-field engine. */
export const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'number', 'decimal', 'currency', 'percent', 'date', 'datetime', 'time', 'checkbox', 'toggle', 'select', 'multi_select', 'radio', 'checkbox_group', 'tags', 'email', 'url', 'phone', 'lookup'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_GROUPS: { group: string; types: { type: CustomFieldType; label: string; desc: string }[] }[] = [
  { group: 'Text', types: [{ type: 'text', label: 'Single line', desc: 'Short text such as a name or code' }, { type: 'textarea', label: 'Multi line', desc: 'Longer notes or descriptions' }, { type: 'email', label: 'Email', desc: 'Validated e-mail address' }, { type: 'url', label: 'URL', desc: 'Web link' }, { type: 'phone', label: 'Phone', desc: 'Phone number' }] },
  { group: 'Number', types: [{ type: 'number', label: 'Number', desc: 'Whole number' }, { type: 'decimal', label: 'Decimal', desc: 'Number with decimals' }, { type: 'currency', label: 'Currency', desc: 'Money amount' }, { type: 'percent', label: 'Percent', desc: 'Percentage value' }] },
  { group: 'Date & time', types: [{ type: 'date', label: 'Date', desc: 'Calendar date' }, { type: 'datetime', label: 'Date & time', desc: 'Date with time' }, { type: 'time', label: 'Time', desc: 'Time of day' }] },
  { group: 'Choice', types: [{ type: 'select', label: 'Dropdown', desc: 'Pick one option' }, { type: 'multi_select', label: 'Multi select', desc: 'Pick many options' }, { type: 'radio', label: 'Radio', desc: 'One option, all visible' }, { type: 'checkbox_group', label: 'Checkbox group', desc: 'Many options, all visible' }, { type: 'tags', label: 'Tags', desc: 'Free-form tags' }, { type: 'lookup', label: 'Lookup', desc: 'Pick from a list you maintain' }] },
  { group: 'Boolean', types: [{ type: 'checkbox', label: 'Checkbox', desc: 'Yes / no' }, { type: 'toggle', label: 'Toggle', desc: 'On / off switch' }] },
];

/**
 * Modules that can carry custom fields. Add an entry when you create a new
 * entity that should support custom fields (and render <CustomFieldInputs moduleName=...>).
 */
export const CUSTOM_FIELD_MODULES: { name: string; label: string }[] = [
  { name: 'users', label: 'Users' },
  { name: 'companies', label: 'Companies' },
  { name: 'categories', label: 'Categories (sample module)' },
];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
