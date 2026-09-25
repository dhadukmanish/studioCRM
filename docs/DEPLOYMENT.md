# Deployment — StudioCRM on SmarterASP.NET / Site4Now

How the client-review environment is built, shipped and verified. The repeatable path is the
`/deploy` Claude Code command; the mechanism is `deploy/Deploy-StudioCRM.ps1`, and everything it
assumes is in `deploy/deploy.config.json`.

**No secret appears in this document, in that config, in the script, or anywhere in git.**

## How this host actually runs a Node app

Read from the host's own deploy log (`node_app_automate_deploy_<id>.log`, which it leaves in the
site root) and from the deployed files themselves. Nothing here is inferred from the plan name:

```
git clone (GitHub, branch from the panel)
   -> railpack builds a Docker image on a LINUX build machine
   -> Build Command runs inside it (pnpm install, pnpm build)
   -> the built tree is copied OUT of the container, tarred,
      SCP'd to the WINDOWS site folder  h:\root\home\jigneshsatani-001\www\studio
      and extracted there
   -> the host rewrites web.config
   -> IIS serves the site and starts Node through httpPlatformHandler
```

So it is **Linux for the build and Windows + IIS for the runtime**. Both halves matter:

- The build half explains why the Build Command must use `pnpm`: the tree has `workspace:*`
  dependencies that npm cannot resolve.
- The runtime half explains `web.config`: **IIS**, not a container, decides which process runs.
  There is no shell, no PM2 and no systemd; the process lifecycle belongs to IIS.

The **Start Command in the panel is not what starts the app.** `web.config`'s `<httpPlatform>`
element is. Setting one and not the other is the single most confusing failure mode here.

### web.config is the thing that breaks

The host's deploy step ends with *"Updating existing web.config to enable Node.js support"*, and the
file it writes registers `httpPlatformHandler` **without an `<httpPlatform>` element**. IIS is then
left with a handler and no process to start, so every request — including `/api/health` — is a
**502**. It also adds `<rewrite>` rules that send anything which is not a file to `/index.html`,
which would turn `/api/health` into the SPA shell and break the API outright.

`deploy/web.config` is the corrected file, and it is deliberately minimal:

- `<httpPlatform processPath="C:\Program Files\nodejs\node.exe" arguments="apps\api\dist\server.js">`
  — the entry point the build produces.
- `PORT=%HTTP_PLATFORM_PORT%`. IIS picks the port and expects the child to listen on exactly it;
  `server.ts` reads `PORT` and binds `0.0.0.0`. Hard-coding a port is a guaranteed 502.
- `stdoutLogFile=".\logs\node.log"` — the only place a startup crash is visible.
- **No rewrite rules.** Routing belongs to the app: `server.js` serves `/api`, serves the
  fingerprinted assets, and falls back to `index.html` itself.

**It must be re-applied after every deploy**, because the host overwrites it every time:

```powershell
.\deploy\Deploy-StudioCRM.ps1 -FixWebConfig
```

A full deploy does it automatically: once the site starts answering with an error page, the host has
finished extracting, and the script uploads `web.config` once and keeps polling.

## Topology — one process, one origin

```
Browser
  |  https   (IIS terminates TLS)
  v
IIS  ->  web.config  ->  httpPlatformHandler  ->  node apps\api\dist\server.js
                                                    |-- /api/*      Fastify API
                                                    |-- /assets/*   React build (immutable, 1 year)
                                                    \-- anything else -> index.html (SPA fallback)
                                                             |
                                                             v
                                                       PostgreSQL (hosted)
```

Why one origin rather than a separate web app and API app:

- The browser client (`apps/web/src/lib/api.ts`) calls `/api/...` as a **relative** URL and has no
  API base URL of its own. Same origin means there is nothing to configure, and no way for a
  production bundle to end up calling `localhost`.
- No CORS preflight, no cross-site cookie question, no mixed content.
- SPA deep links are handled by the application (`apps/api/src/plugins/web.ts`), not by IIS rewrite
  rules — one place decides routing, and the deploy check covers it.

### What the build produces

`pnpm build` leaves the **whole deployable app in one folder**:

```
apps/api/dist/
  server.js        the entire API + static serving, one self-contained bundle (~2.8 MB)
  public/
    index.html     the SPA shell (no-cache)
    assets/...     fingerprinted JS/CSS (immutable, cached for a year)
  db/              migrate.js and seed.js — built, never run by the app
```

`apps/api/build.mjs` bundles **everything** — third-party dependencies and the workspace
`@erp/shared` alike (`external: []`), because `@erp/shared` publishes TypeScript source
(`main: ./src/index.ts`) and leaving it external produced a bundle Node could not start.
`deploy/collect-dist.mjs` then copies `apps/web/dist` to `apps/api/dist/public`, which is exactly
where `apps/api/src/plugins/web.ts` looks. `pnpm start` runs that folder, and `node
apps/api/dist/server.js` is the same thing without pnpm — which is what IIS runs.

The bundle is stamped with the commit it was built from (`BUILD_COMMIT`, defaulting to
`git rev-parse --short HEAD`) and the build time. Source maps are **off** by default — they inline
the entire server source and the web root is public. Use `SOURCEMAP=1` for local debugging only.

## Control panel settings

Websites → `studio` → the Node app page. Deploy target `/studio`.

| Setting | Value | Why not the default |
| --- | --- | --- |
| Deployment Method | **Git Repository** | The host's intended path, and it makes every later deploy one webhook call. |
| Git Repository URL | `https://github.com/dhadukmanish/studioCRM.git` | |
| Git Branch | **`main`** | The panel's own default, and the point: `main` is what is live, so the two can never drift apart. Feature branches merge **into** `main` before a deploy. |
| Deployment Key | **none needed** | The repository is **public** (verified against the GitHub API), so the clone works unauthenticated. A `fatal: could not read Username for 'https://github.com'` in the log means the repo has been made private; a read-only PAT for that one repository fixes it. |
| Build Command | **`pnpm install --prod=false && pnpm build`** | The `npm run build` default cannot resolve this repo's `workspace:*` dependencies. `--prod=false` keeps the devDependencies the web build needs even if `NODE_ENV=production` is set at install time. |
| Start Command | `pnpm start` | Harmless to set, but **not** what starts the app — `web.config` is. See above. |

**The repository being public is a standing decision worth knowing about.** No secret is in it —
`apps/api/.env` is gitignored and the server's own `.env` is uploaded by hand — but the whole
codebase, including this document and the database host name, is readable by anyone. Making it
private is fine; it just means adding a read-only PAT in the panel.

Tick **Create Deploy Hook** and keep the URL it produces. Anyone holding it can trigger a rebuild,
so treat it as a credential — it belongs in `$env:STUDIOCRM_DEPLOY_HOOK` or in `deploy/.env.deploy`
(gitignored), and nowhere else.

**The hook does not accept a hand-made request.** It is a GitHub webhook receiver
(`github.site4now.net/github/deployhook?token=...`), and it answers **HTTP 200 while refusing**,
saying so only in the body:

```json
{"job":{"msg":"Invalid","state":"ERROR","createdAt":"..."}}
```

An empty POST, a `{"ref":"refs/heads/main"}` push event and a full GitHub push payload with
`X-GitHub-Event: push` were all refused this way — so it wants something a caller here cannot
reproduce, most likely a signature. **Anything that treats 200 as success will wait for a build
that never started**, which is exactly what happened on the first attempt. The script now reads the
body and stops.

Until the hook is wired into the repository's own webhook settings, a deploy is triggered by
clicking **Deploy Now** in the panel.

## Environment variables

`server.js` loads `dotenv/config`, and IIS starts it with the **site root** as the working
directory, so the file it reads is **`.env` in the site root** — uploaded by hand over FTPS, never
by any script and never in git. `PORT` and `NODE_ENV` come from `web.config` instead.

| Name | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | site-root `.env` | PostgreSQL connection string. Copy it from `apps/api/.env`. The password contains `@@`, which must stay percent-encoded as `%40%40` or the URL parses wrong. |
| `JWT_SECRET` | site-root `.env` | Signing key for access/refresh tokens. **Must be a fresh random value, not the development `change-me-in-production`.** Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it invalidates existing refresh tokens, which is fine — everyone logs in again. |
| `PORT` | `web.config` | `%HTTP_PLATFORM_PORT%`. IIS owns it. Never set it in `.env` — a value there is ignored anyway, because `dotenv` does not override what the process already has, but it invites confusion. |
| `NODE_ENV` | `web.config` | `production`. |
| `PUBLIC_APP_URL` | site-root `.env` | The origin customers open invoice links on: `https://studio.kriviinfotech.com`. Put into every WhatsApp invoice link (`/i/<token>`, docs/WHATSAPP_SHARING.md) — never taken from the request's Host header. `https` required. Missing → creating a link answers 503. |
| `PUBLIC_LINK_SECRET` | site-root `.env` | Signs public invoice link tokens. 32+ random characters, a **different** value from the development one: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`. Server-side only — never in git or the web bundle. **Changing it invalidates every invoice link already sent** (accepted; it doubles as the emergency "revoke all links"). |
| `CORS_ORIGIN` | — | Deliberately unnecessary: the browser and the API share an origin, so no request is cross-origin. |
| `LOG_LEVEL` | optional | Defaults to `info`. |
| `WEB_ROOT` | optional | Defaults to `public/` beside `server.js`, which is the layout above. |

The panel also has an Environment Variables section. It is fine to use, but the site-root `.env` is
what has actually been proven to work here.

## Migration policy

**The hosted database is live client data.** It is the same database development points at.

- Deployment **never** migrates as a side effect. Nothing at startup migrates, seeds or creates a
  schema — `server.ts` only builds the app and listens, so restarting it repeatedly is always safe.
  `dist/db/migrate.js` and `dist/db/seed.js` ship but nothing invokes them.
- Before deploying a schema change, compare `apps/api/drizzle/meta/_journal.json` with the applied
  rows in `drizzle.__drizzle_migrations`. Equal counts mean nothing is pending.
- If a migration **is** pending: review the generated SQL, confirm it is additive, and run
  `pnpm db:migrate` as its own approved step. `/deploy` stops and asks rather than doing it.
- Never `drizzle-kit push`, never reset, never drop, never seed. `db:seed` targets this database and
  `.claude/hooks/guard-bash.mjs` blocks it on purpose.
- If the state is ambiguous — hashes that do not line up, or the database ahead of the journal —
  **stop and report**. Do not guess.

As of the first StudioCRM deployment: 12 journal entries, 12 applied, nothing pending.

## Deploying

```powershell
# credentials: this shell only, or deploy/.env.deploy (gitignored)
$env:STUDIOCRM_DEPLOY_HOOK   = '...'   # panel -> Deploy Hooks
$env:STUDIOCRM_FTP_PASSWORD  = '...'   # only needed to re-apply web.config

.\deploy\Deploy-StudioCRM.ps1 -DryRun        # gates + report, contacts nothing
.\deploy\Deploy-StudioCRM.ps1 -Push          # push the branch, trigger, repair, wait, verify
.\deploy\Deploy-StudioCRM.ps1 -FixWebConfig  # re-apply web.config only
.\deploy\Deploy-StudioCRM.ps1 -Hotfix        # replace the deployed server bundle, then web.config
.\deploy\Deploy-StudioCRM.ps1 -VerifyOnly    # re-check what is already live
```

What a full run does, in order:

```
read config -> git preflight -> typecheck -> tests -> build -> (push) -> trigger hook
   -> wait 5 minutes, then re-apply web.config every 90s while the site is silent
   -> wait for the live build SHA to become HEAD -> verify -> report
```

The five-minute quiet period is not arbitrary: the host rewrites `web.config` at the very **end** of
its run, about seven minutes after the trigger, so repairing it earlier accomplishes nothing and the
repair has to keep trying rather than fire once.

`-Hotfix` uploads the locally built `apps/api/dist/server.js` over the deployed one and repairs
`web.config`. It is the way back when the site is down and the pipeline cannot be triggered, and it
is honest about its cost: the server tree then matches no single commit until the next real deploy,
and it only works while the web assets are unchanged between the deployed commit and `HEAD`. It runs
no gates, so build first.

- It refuses to run while `appUrl` is `TODO`, and refuses to deploy a commit that is not on the
  remote branch the panel clones (unless `-Push` is given). Both are guesses it will not make.
- It **never pushes without `-Push`** and never commits.
- `erp-boilerplate.bundle` and `studio form image.pdf` are intentional untracked files; it ignores
  them and mentions anything else untracked only to say it will not be deployed.
- It never touches the database.

## What a failed deploy leaves behind

Less than you would hope, and this is the part to understand before deploying again.

The host extracts the new tree **over** the site folder and then rewrites `web.config`. So the
window between "the host finished" and "`web.config` is repaired" is a **502 on the whole site** —
not a graceful old-version fallback. The first StudioCRM deploy went exactly this way: the build
succeeded, the files landed, and the site returned 502 until `web.config` was put back.

It is therefore not a zero-downtime deployment, and it should not be pretended otherwise. Deploy
when a few minutes of downtime is acceptable.

The host keeps its own backup of the previous tree in the site root as
`production_studio_<id>.tar.gz.backup`, which is the fastest way back if an extraction goes wrong.

## Reading the host's own logs

Everything diagnostic is in the site root, over FTPS (explicit TLS, port 21,
`win8194.site4now.net`, user `studiodev`):

| File | What it tells you |
| --- | --- |
| `node_app_automate_deploy_<id>.log` | the whole build: clone, install, build, copy, extract, and an explicit `SUCCESS` or failure at the end |
| `logs\node.log` | the Node process's own stdout/stderr — where a startup crash appears |
| `web.config` | whether the `<httpPlatform>` element is still there |

Failures seen so far:

| Symptom | Cause | Fix |
| --- | --- | --- |
| 502 on every path, deploy log says `SUCCESS` | the host rewrote `web.config` without `<httpPlatform>` | `-FixWebConfig` |
| Requests hang and never answer, `logs\node.log` shows `ERR_INVALID_ARG_VALUE` with `path: '19281               '` | `PORT` arrived padded with spaces and was taken for a named pipe | fixed in `lib/listen.ts`; if it ever returns, that trim is what broke |
| The hook answers 200 but no new deploy log appears | the hook refused the request in its body (`"state":"ERROR"`) | click **Deploy Now** in the panel |
| `fatal: could not read Username for 'https://github.com'` | the repo has been made private and the panel has no Deployment Key | paste a read-only GitHub PAT in the panel |
| `Unsupported URL Type "workspace:"` | the build ran under npm | Build Command must use `pnpm` |
| `vite: not found` / `tsc: not found` | devDependencies were pruned at install | keep `--prod=false` in the Build Command |
| `/api/health` returns the SPA shell | the host's `<rewrite>` rules are still in `web.config` | `-FixWebConfig` (the correct file has no rewrite rules) |

## Health verification

`GET /api/health` — public, unauthenticated, and deliberately thin:

```json
{ "message": "OK", "data": { "status": "up", "db": "up", "version": "9c56447", "builtAt": "...", "time": "..." } }
```

- `db` is only `up` or `down` — never the host, the user, the driver's message or a stack trace.
- `version` is the short commit the bundle was built from. That is how a deploy proves the rebuild
  actually took effect, and how anyone can tell which build is live. The client UI shows none of it.

A build that reports **no** `version` field at all is older than this deployment work.

The script also checks that a refresh on `/modules/billing/new` returns the app shell and that an
unknown `/api/...` path still returns a JSON 404.

Verified locally against the real bundle before the first deployment, with the same entry point IIS
uses:

```
GET /api/health           -> 200 {"status":"up","db":"up","version":"ca96589",...}
GET /api/no-such-route    -> 404 application/json
GET /modules/billing/new  -> 200 text/html   (app shell)
GET /assets/index-*.js    -> 200 public, max-age=31536000, immutable
```

## SPA routing

React routes (`/modules/billing`, `/modules/billing/new`, `/modules/billing/:id`,
`/modules/appointments`, `/modules/masters/*`) are not files. `apps/api/src/plugins/web.ts` installs
the fallback and `plugins/errors.ts` calls it: a GET that no API route claimed and no file matches
returns `index.html`, so a refresh or a pasted deep link works. Anything under `/api/` stays a JSON
404, so a mistyped endpoint can never answer with HTML.

This is why `web.config` must carry no rewrite rules of its own.

## Rollback

**Application rollback and database rollback are different things. Never conflate them.**

### Application

The image is built from a commit, so rolling back is choosing a different commit: point the deploy
branch at the previous commit (or a tag on it), trigger a rebuild, re-apply `web.config`, and verify
`/api/health` reports that SHA. Never force-push to do it without explicit approval.

If an extraction itself goes wrong, the host's own `production_studio_<id>.tar.gz.backup` in the
site root holds the previous tree.

### Database

**Migrations are not reversed automatically, and `/deploy` will not do it.** A schema change is
undone only by a new, reviewed, forward migration that is itself data-safe. Rolling the application
back does **not** roll the schema back, and does not need to: every migration in this project so far
is additive, so an older build runs unchanged against a newer schema.

If a migration ever were not additive, the rollback plan has to be designed with it, before it is
applied — not after.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| 502 on everything | `web.config` lost its `<httpPlatform>` element. Run `-FixWebConfig`. |
| Health answers but `db: "down"` | `DATABASE_URL` is missing or wrong in the site-root `.env`. Check that `@@` in the password is percent-encoded as `%40%40`. |
| Live `version` is not the commit you pushed | The panel cloned a different branch, or the build failed. The deploy log says which. |
| A startup crash with no clue | `logs\node.log` in the site root. |
| Deep link 404s with JSON | `apps/api/dist/public` was not in the tree — `pnpm build` did not run `deploy/collect-dist.mjs`. |
| Login fails with a valid password | `JWT_SECRET` is unset or changed. Log in again. |
| Nobody but Super Admin can open a module | Role grants are stored JSON written before the newer permissions existed. Open each role in Settings → Roles and save it. |

## Where it is served

`https://studio.kriviinfotech.com` — valid certificate, and the site root is
`h:\root\home\jigneshsatani-001\www\studio`, reachable over FTPS as `/`.

Before the first StudioCRM deploy the host was serving the **bare boilerplate** there (title
`ERP Boilerplate`, from `main` at `7cb23c9`, running as a single `index.js` at the site root). That
earlier arrangement is what proved `<httpPlatform>` is how Node starts on this host; its
`web.config` survives in the site root as `web.config.bak`.

### Live as of 2026-09-24

```
GET /api/health          -> {"status":"up","db":"up","version":"6f9ac2e","builtAt":"..."}
GET /                    -> 200 text/html, <title>StudioCRM</title>
GET /modules/billing/new -> 200 text/html   (app shell, so a refresh works)
GET /api/no-such-route   -> 404 application/json
GET /api/bills           -> 401             (authorization is enforced)
GET /assets/index-*.js   -> 200 public, max-age=31536000, immutable
GET /                    -> Cache-Control: no-cache
```

Two things about it are still open, and neither is cosmetic:

- **`JWT_SECRET` in the site-root `.env` has not been proven to be a fresh value.** If it is still
  the development `change-me-in-production`, anyone can mint a valid token for a public site. Rotate
  it in that file and restart, then log in again.
- **`http://` is served as well as `https://`, with no redirect.** Worth adding at the host or in
  front of the app before real client data is entered.

Stored in this repo: `appUrl` only. Kept out of it: the **Deploy Hook URL**, the **FTP password**,
the site-root **`.env`**, and a **GitHub PAT** if the repository is ever made private.
