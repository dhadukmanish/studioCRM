# Dashboard

The landing page (`/dashboard`): the studio's figures at a glance. Administration — users, roles,
permissions, companies, custom fields — is **not** on it; it lives in Settings.

Read-only and derived. Every figure is the definition the module behind it already owns, so the
dashboard can never disagree with the screen a figure links to. No table, no stored total, no
migration.

## Sections

| Section | Figures | Definition (owner) | Shown to |
| --- | --- | --- | --- |
| Today (attention) | Appointments today · Deliveries due today · Overdue deliveries · Overdue appointments | pending appointment dated today / before today; a bill whose promised Delivery Date is today / before today and Delivery not recorded (`services/work.ts`) | per figure, as below |
| Inquiries | Total · Pending · Done | appointments dated in the period; Pending until Done (`completed_at`, `services/appointments.ts`) | Appointments (read) |
| Orders | Total · Completed · Pending | bills dated in the period; Completed = Delivery recorded (the job is closed) | Billing or Studio Work (read) |
| Order process status | Selection · Editing · WhatsApp · Delivery due · Completed | each period bill at its derived workflow position (`workPositionSql`); sums to Total orders | Billing or Studio Work (read) |
| Payments | Billed in period · Received on these bills · Outstanding on these bills · Total outstanding (+ bills / customers owing) | `receivablesOverview` as of today — over the period's bills, and over every bill (`services/receivables.ts`); an unapplied advance or a cancelled receipt never counts | Billing, Receipts or Receivables Reports (read) |

"Inquiries" are appointments: StudioCRM has no separate inquiry/lead module (decided with the
client). "Completed" means delivered, never paid — delivery and payment are independent
(`docs/STUDIO_WORKFLOW.md`).

## Period

Today · This month (default) · Last month · This FY (1 April – 31 March) · Custom. The server resolves
the period from the tenant's business date (`periodRange` in `@erp/shared`, the company's time
zone) — the browser never decides what "this month" is. It lives in the URL
(`?period=THIS_FY`, `?period=CUSTOM&from=…&to=…`), so a view can be bookmarked.

Orders count bills dated in the period **up to today** — the same bills the money figures
cover, so Total orders and Billed in period never describe different sets; appointments may be
booked ahead and count to the period end. The Today figures ignore the period. Money is always **as of today**, like Reports → Receivables:
a bill dated after today is not yet counted, and Received is what active receipts dated up to
today put on those bills.

## API and RBAC

`GET /api/dashboard?period=&from=&to=` — any signed-in user. Each section is decided on the
server by the permission of the module it summarises; a section the user may not see is neither
queried nor returned, and the page draws only what came back. A role with none of those modules
sees a short explanation instead of an empty page.

## Tests

`apps/api/src/routes/dashboard.test.ts` — period ranges (month ends, leap years, the financial
year), the query schema, and on the throwaway database: every figure against real appointments,
bills, stages and receipts; money equal to the Receivables overview; sections by permission;
tenant isolation; nothing written. `apps/web/src/pages/dashboard/DashboardPage.test.tsx` — renders
what the server returned, the period switch and URL, no admin shortcuts.
