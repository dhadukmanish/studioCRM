# SaaS subscriptions and the platform panel

StudioCRM is sold to studios as a subscription. The **platform** (the company selling it) runs a
separate panel where it creates studios, grants subscription periods, records the payment for each,
and suspends or reactivates studios. **Every feature is available on every plan — a plan only buys
time.** Feature limits per plan are deliberately not built yet.

## Actors and separation

| | Studio user | Platform admin |
| --- | --- | --- |
| Table | `users` (tenant-scoped) | `platform_admins` (no tenant) |
| Sign-in | `POST /api/auth/login` | `POST /api/platform/auth/login` (10 / email and 30 / IP per 15 min; a flooded limiter refuses rather than resets) |
| Token | JWT `{ sub, tenantId }` + refresh token | JWT `{ sub, tenantId: '', kind: 'platform' }`, 12 h, no refresh |
| Routes | every studio route | only `/api/platform/*` |

A platform token is refused by every studio route (`plugins/auth.ts`), and a studio token —
including a studio's own *Super Admin* — is refused by every platform route (`routes/platform.ts`).
The studio "Super Admin" role is the studio owner, not the platform.

The panel is the same web build, at `/platform/*` on every host. Live it is reached as
**control.kriviinfotech.com**, a separate hosting site whose only content is
`deploy/control-redirect/web.config` (+ an `index.html` fallback), redirecting every request to
`https://studio.kriviinfotech.com/platform` — the host refuses to bind a second domain to a
subdomain site. If a `control.*` host ever serves the build itself, it shows only the panel
(`isPlatformHost`). This is routing convenience only — the security boundary is the token kind,
never the Host header.

## Plans

`subscription_plans` — `name`, `kind`, `duration_days`, `price` (`numeric(12,2)`), `is_active`, `sort_order`.
**The platform defines every plan itself** in the panel's Plans page — nothing is seeded. Any number
of plans per kind is allowed (e.g. a 90-day plan is a `MONTHLY`-kind plan with 90 days).

| Kind | Days | Price |
| --- | --- | --- |
| `TRIAL` | fixed (e.g. 7) | always charged 0; **once per studio** (a cancelled trial may be re-granted — mistake recovery) |
| `DAYS` | chosen per grant (`duration_days` NULL) | `price` is per day → price × days |
| `MONTHLY` | fixed (e.g. 30) | `price` |
| `YEARLY` | fixed (e.g. 365) | `price` |

A plan's kind cannot change after creation (create a new plan instead); an inactive plan cannot be
granted. A plan that has **never been granted** can be deleted (`DELETE /plans/:id`); once granted it
is kept for history (`409 SUB_005`, FK `restrict`) — make it inactive instead. The plan list carries
`usedCount` (periods ever granted on it, cancelled included).

## Periods (`tenant_subscriptions`)

One row = one granted period + the payment taken for it: `starts_on`, `ends_on` (**inclusive**),
`days`, `amount`, `payment_mode` (CASH / UPI / BANK / CHEQUE / OTHER), `payment_ref`, `paid_on`,
`notes`, plus plan name/kind **snapshots**. Rules:

- **Expiry is derived, never stored**: the studio's `endsOn` = max `ends_on` over its ACTIVE periods.
- **Continuity**: a new period starts the day after the current one ends, or today if nothing is
  running (`nextPeriod`) — renewing early never wastes paid days. Grants take the tenant row
  `FOR UPDATE`, so concurrent renewals chain instead of overlapping.
- **Amount** defaults to the list price (`planAmount`, exact in paise); the admin may override it
  (discount). A non-zero amount requires a payment mode; `paid_on` defaults to today.
- **Never edited or deleted** — a mistaken period is *cancelled* with a reason; the expiry falls
  back to the remaining periods. **Only the latest ACTIVE period can be cancelled** (`409 SUB_004`
  otherwise): periods chain end to end, so cancelling an earlier one would not shorten the expiry and
  the studio would keep days nobody paid for. Cancel runs under the same tenant lock as grants.
- An amount beyond `numeric(12,2)` is a 400, not a database error.
- "Today" for subscriptions is the platform's business date in `Asia/Kolkata`.

## Status — `deriveSubscriptionAccess` (packages/shared) is the only definition

| Status | When | Effect |
| --- | --- | --- |
| `UNMANAGED` | the studio has never had a period (pre-SaaS studios) | unrestricted |
| `TRIAL` / `ACTIVE` | today ≤ endsOn | full access |
| `GRACE` | paid period ended ≤ 3 days ago (`SUBSCRIPTION_GRACE_DAYS`); trials get no grace | full access + banner |
| `EXPIRED` | after that (also: managed but every period cancelled) | **read-only** |
| `SUSPENDED` | `tenants.is_active = false` | nothing works, not even sign-in |

Every studio created from the panel starts with a period, so it is never UNMANAGED. A legacy
studio becomes managed the moment the platform grants its first period.

## Enforcement

In `authenticate` (`plugins/auth.ts`), so every studio route is covered — one query per request
(tenant left-joined to its periods, aggregated), kept on `req.tenantAccess` so `/api/auth/me` reuses it:

- SUSPENDED → `403 SUB_003` on every request; sign-in and refresh also refuse it. Suspending deletes
  the studio's refresh tokens.
- EXPIRED → any non-GET → `402 SUB_001`, except `/api/auth/*`, `/api/column-preferences`,
  `/api/filter-groups`. Reading, printing, PDFs and existing public invoice links keep working.
  Data is never deleted; a renewal restores writes immediately.
- Login, refresh and `GET /api/auth/me` return `subscription` (status, endsOn, daysLeft, readOnly,
  blocked, planName) — the studio app's banner reads it.

## Studio creation

Only from the panel (`POST /api/platform/studios`), in one transaction: tenant → `seedTenantDefaults`
(roles, company, branch, settings, templates) → owner user with the Super Admin role → first period.
Any failure rolls all of it back.

**Login identity is platform-wide**: sign-in matches the typed value (lowercased) against BOTH
`email` and `username` across all studios, so each new email or username is checked against both
columns of every studio's users — for the owner here and for every user created or edited in a
studio (`assertLoginIdentityFree`). Usernames are stored lowercased. The check takes a
`pg_advisory_xact_lock` on the value inside the writing transaction, so a double-submitted studio or
two studios claiming the same email at once cannot both succeed. A global unique index is a possible
later hardening once existing data is confirmed clean.

## API (`/api/platform/*`, all need a platform token except login)

`auth/login` · `auth/me` · `PUT auth/change-password` · `GET summary` · `GET|POST plans` ·
`PUT|DELETE plans/:id` · `GET|POST studios` · `GET|PUT studios/:id` · `POST studios/:id/status` ·
`POST studios/:id/owner-password` · `POST studios/:id/subscriptions` ·
`POST studios/:id/subscriptions/:sid/cancel`.

## Studio backups

`GET /api/platform/studios/:id/backup` (platform token only; button **Download backup** on the
studio's page) returns a ZIP of that one studio's data — studios ask the provider; they cannot
download it themselves:

- `csv/<table>.csv` — one per table, UTF-8 with BOM, opens in Excel, formula-injection guarded
  (`lib/csv.ts`); JSON columns as JSON text, images as a "[binary …]" note.
- `backup.json` — every table with exact values (numeric as strings, images as base64), plus the
  studio and per-table row counts; `format: "studiocrm-backup", version: 1`.
- `README.txt` — what is inside and the row counts.

**Every table with a `tenant_id` is included automatically** (`services/studioBackup.ts`), so a new
table needs no change, filtered strictly by that studio's id. Excluded: `tenant_subscriptions`
(platform billing), `public_invoice_links` (token hashes), and `users.password_hash`. Each download
is recorded in the studio's own activity log (`entity_type = 'backup'`, the admin's email). Built in
memory — fine at today's sizes; stream it if a studio grows very large. There is no restore yet.

## Bootstrap

```
PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_NAME="..." PLATFORM_ADMIN_PASSWORD=... pnpm --filter @erp/api platform:setup
```

Idempotent: creates the first admin; `--reset-password` resets an existing admin. It creates no
plans — sign in to the panel and add them under Plans before creating the first studio. The password comes from the
environment and is never printed.

## Not built yet / known limits

- A suspended studio's existing public invoice links (`/i/<token>`) still open — decide whether
  suspension should cover them.
- Password resets end refresh tokens but an already-issued access token lives until it expires
  (same as the studio's own change-password).

Online payment (Razorpay + webhook), public self-signup, plan feature limits, expiry reminders
(WhatsApp / email), a platform audit log beyond `created_by` / `cancelled_by` on periods, invoices
for the subscription itself, restoring a studio from a backup.
