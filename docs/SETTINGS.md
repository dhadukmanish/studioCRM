# Settings — company profile, application settings, dates and logo

How StudioCRM knows **who the studio is** (name, logo, letterhead details) and **how it wants
things shown** (date format). Both are tenant-scoped, read from the caller's token, and have
exactly one source each. Future Invoice Preview / PDF / Templates read the same two sources.

## Two sources, never mixed

| Concern | Source of truth | Read through | Edited in |
| --- | --- | --- | --- |
| **Company** — name, logo, legal name, GSTIN (`tax_id`), phone, email, website, address | The tenant's **default company** row (`companies`, `is_default = true`) + its row in `company_logos` | `GET /api/settings/company` → `getCompanyProfile()` (`services/company.ts`) | Settings → Companies |
| **Application** — date format, time format, theme, session length … | `app_settings.settings` (one JSON row per tenant) | `GET /api/settings` → `getSettings()` (`services/settings.ts`) | Settings → General |

Retired, kept only because dropping a column is destructive: `companies.date_format` (the date
format is an application setting, not a company one) and `companies.logo_url` (always NULL).
The old `appName` setting was removed — it duplicated the company name and nothing rendered it.

**Company name vs product name.** The company name ("ClickG") is the tenant's and comes from the
profile. The product name ("StudioCRM") is the application's and comes from the build
(`VITE_APP_NAME`). The sidebar shows both: company on the first line, product under it. The
login page shows the product only, because no tenant is known before sign-in. `tenants.name` is
an internal label and is not rendered anywhere.

## Dates: stored canonical, shown per setting

- **Storage never changes with the setting.** A business date (Bill, Delivery, Birth,
  Appointment) is a Postgres `date`, `"YYYY-MM-DD"` on the wire; a clock time is `time`; an
  audit instant is `timestamptz`. The zod schemas accept only `YYYY-MM-DD` — a display-format
  string can never be stored.
- **One formatter**, `packages/shared/src/dates.ts`. In the browser it is reached only through
  `useDateFormatters()` (`apps/web/src/lib/settings.ts`), which binds it to the tenant's settings:
  `date()` for a business date, `time()` for a clock time, `stamp()` / `stampTime()` for Created
  At / Last Modified / Last Login. `lib/format.ts` deliberately has no date formatter any more.
- **No timezone shift.** A business date is formatted and parsed on its digits and never goes
  through `new Date('YYYY-MM-DD')` (UTC midnight — the previous day anywhere behind UTC).
  Timestamps are real instants and are shown in the viewer's local time.
- Supported formats: `dd-MM-yyyy` (default), `dd/MM/yyyy`, `MM/dd/yyyy`, `yyyy-MM-dd`. Time:
  `hh:mm tt` (default, "02:30 PM") or `HH:mm`. `PUT /api/settings` refuses anything else; an
  unknown stored value falls back to the default rather than breaking every screen.

## Date input: `<DateInput>`, never `<input type="date">`

A native date input renders in the **operating system's** locale — an en-US Windows shows
09/25/2026 whatever the app's setting says, and no attribute can change that. So every app date
field is `DateInput` (`components/ui/DateInput.tsx`):

- a text field showing the tenant's format, with the format as its placeholder;
- the value it reports is always `"YYYY-MM-DD"` or `''`; half-typed text is reported as typed so
  the form can refuse it (`validDate`) instead of silently blanking it;
- forgiving entry — `/ - .` or space as separator, `5/9/2026`, a pasted ISO date;
- the calendar is the browser's own month grid, opened by the icon, Alt+↓ or F4 through a hidden
  native input's `showPicker()` — it shows no date text, so its locale cannot leak. No calendar
  library was added.
- Filters (`DataTable`) only ever commit a complete ISO date to a filter value, because the
  server casts it with `::date`.

Still native, deliberately: `<input type="time">` for the Appointment time (the phase did not
change time behaviour), and the custom-field `datetime-local` / `time` types (no tenant uses them).

## Logo

- Stored **in the database** (`company_logos`: `company_id` PK, `tenant_id`, `content_type`,
  `byte_size`, `data bytea`, `updated_at`), one row per company, deleted with it. Not on disk:
  the host replaces the site folder on every deploy. Kept out of `companies` so listing or
  editing a company never loads the image.
- Tenant-safe composite FK `(company_id, tenant_id) → companies(id, tenant_id)`
  (`companies_id_tenant_uk`, migration `0012`; the table is `0013`).
- `PUT /api/admin/companies/:id/logo` (multipart, `admin_companies` update): PNG, JPEG or WebP
  only, decided by the file's **own leading bytes**, never by its name or declared type. SVG is
  refused (it can carry script). 1 MB cap — the reader takes 1 MB + 1 byte, because
  `@fastify/multipart` truncates an oversized file instead of always throwing.
  `DELETE` removes it. Both are audit-logged against the company.
- `GET /api/admin/companies/:id/logo` needs a session only (every sidebar shows it), looks the
  company up inside the caller's tenant (another tenant's id is 404), and sends `nosniff`.
- **Versioning.** The profile carries `logo: { version, contentType }`; `version` is the upload
  time. The URL is `…/logo?v=<version>`, so a new upload is a new URL and the response can be
  cached as immutable. An `<img>` cannot send the bearer token, so the browser fetches it through
  the api client and shows it as a data URL, cached by React Query per version.
- **Display.** A fixed square in the sidebar with `object-fit: contain` — any shape or size is
  scaled down undistorted and can never grow the header. No logo → the company's initials; a
  logo that fails to load → initials, never a broken image.

## Caching and live effect

| Query key | Holds | Invalidated by |
| --- | --- | --- |
| `['settings']` | application settings | saving General Settings |
| `['companies', 'profile']` | company profile | anything invalidating `companies` — saving a company (MasterPage) or its logo |
| `['company-logo', id, version]` | the image as a data URL | never needed: a new version is a new key |

Each hook is one shared cached query, so a table with a thousand dates makes no extra request.
Changing the date format, the company name or the logo takes effect on every screen at once,
with no reload and no sign-out.

## For the Invoice phase

An invoice renders from four separate things, and must keep them separate:

1. the **bill** — its own historical snapshot (customer, lines, rates, GST, discount, totals),
   which Settings never touch;
2. the **company profile** — `getCompanyProfile(tenantId)` + the logo bytes (`getCompanyLogo`),
   current values, unless a later requirement asks for historical branding snapshots;
3. the **application settings** — `dateFormat` for printing dates with the same shared
   `formatDateOnly`;
4. the **invoice template** — layout and sections only (not built yet).

A server-side PDF renderer can import `@erp/shared` and call the same date functions, so a printed
invoice and the screen can never disagree about a date.
