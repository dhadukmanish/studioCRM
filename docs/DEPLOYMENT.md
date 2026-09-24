# Deployment — StudioCRM on SmarterASP.NET / Site4Now Node hosting

How the client-review environment is built, shipped and verified. The repeatable path is the
`/deploy` Claude Code command; the mechanism is `deploy/Deploy-StudioCRM.ps1`, and everything it
assumes is in `deploy/deploy.config.json`.

**No secret appears in this document, in that config, in the script, or anywhere in git.**

## How this host actually runs a Node app

Established from the host's own build log (`node_app_automate_deploy_<id>.log`, which it writes
to the site root), not assumed:

- The app runs as a **Linux container**, built by **railpack** through Docker.
- The image is built from a **git clone** of this repository, or from a zip uploaded in the panel.
- The panel supplies a **Build Command**, a **Start Command** and **environment variables**, and
  injects a numeric **`PORT`** the process must listen on.

So this is **not** an IIS site: there is no `web.config`, no iisnode, no FTP upload of the
application. An earlier version of this tooling assumed IIS and was wrong; the `web.config` and
the FTPS uploader have been removed rather than left to mislead.

**FTP is still useful for exactly one thing:** reading the host's build log. Files copied there do
not become the running container.

## Topology — one process, one origin

```
Browser
  |  https   (the host terminates TLS)
  v
container  ->  pnpm start  ->  node apps/api/dist/server.js     (one Node process)
                                 |-- /api/*      Fastify API
                                 |-- /assets/*   fingerprinted React build (immutable, 1 year)
                                 \-- anything else -> index.html (SPA fallback)
                                          |
                                          v
                                    PostgreSQL (hosted)
```

Why one origin rather than a separate web app and API app:

- The browser client (`apps/web/src/lib/api.ts`) calls `/api/...` as a **relative** URL and has
  no API base URL of its own. Same origin means there is nothing to configure, and no way for a
  production bundle to end up calling `localhost`.
- No CORS preflight, no cross-site cookie question, no mixed content.
- SPA deep links are handled by the application (`apps/api/src/plugins/web.ts`), not by host
  rewrite rules — one place decides routing, and the deploy check covers it.

### What the build produces

`pnpm build` leaves the **whole deployable app in one folder**:

```
apps/api/dist/
  server.js        the entire API + static serving, one self-contained bundle
  public/
    index.html     the SPA shell (no-cache)
    assets/...     fingerprinted JS/CSS (immutable, cached for a year)
  db/              migrate.js and seed.js — built, never run by the app
```

`apps/api/build.mjs` bundles **everything** — third-party dependencies and the workspace
`@erp/shared` alike (`external: []`), because `@erp/shared` publishes TypeScript source
(`main: ./src/index.ts`) and leaving it external produced a bundle Node could not start.
`deploy/collect-dist.mjs` then copies `apps/web/dist` to `apps/api/dist/public`, which is exactly
where `apps/api/src/plugins/web.ts` looks. `pnpm start` runs that folder, and it is the same
command locally, in the container, or from a zip.

The bundle is stamped with the commit it was built from (`BUILD_COMMIT`, defaulting to
`git rev-parse --short HEAD`) and the build time. Source maps are **off** by default — they inline
the entire server source and the web root is public. Use `SOURCEMAP=1` for local debugging only.

## Control panel settings

Websites → `studio` → the Node app page. Deploy target `/studio`.

| Setting | Value | Why not the default |
| --- | --- | --- |
| Deployment Method | **Git Repository** | The host's intended path, and it makes every later deploy one webhook call. |
| Git Repository URL | `https://github.com/dhadukmanish/studioCRM.git` | |
| Git Branch | **`masters/account-master`** | **Not `main`.** `origin/main` predates the whole Masters / Appointments / Billing layer — deploying `main` deploys none of the app. |
| Deployment Key | **Personal Access Token** | The repository is private. Without a token the clone fails with `fatal: could not read Username for 'https://github.com'` — which is exactly how the first queued deploy failed. |
| Build Command | **`pnpm install --prod=false && pnpm build`** | The `npm run build` default cannot resolve this repo's `workspace:*` dependencies. `--prod=false` keeps the devDependencies the web build needs even if `NODE_ENV=production` is set at install time. |
| Start Command | **`pnpm start`** | Runs the one bundle. |
| Node version | newest LTS the panel offers (>= 20) | The bundle targets `node20` and needs >= 18 for `fetch`. |

The **PAT is pasted into the panel by hand** and appears nowhere else — not in this repo, not in
a script, not in a log. Give it read access to that one repository and nothing more.

Tick **Create Deploy Hook** and keep the URL it produces: it is what turns a deploy into one
request. Anyone holding it can trigger a rebuild, so treat it as a credential — it belongs in
`$env:STUDIOCRM_DEPLOY_HOOK` or in `deploy/.env.deploy` (gitignored), and nowhere else.

## Environment variables

Set in the panel's **Environment Variables** section. Names only — no value of any of these
belongs in git, a doc, a log or a chat message:

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. Copy it from `apps/api/.env`. The password contains `@@`, which must stay percent-encoded as `%40%40` or the URL parses wrong. |
| `JWT_SECRET` | yes | Signing key for access/refresh tokens. **Must be a fresh random value, not the development `change-me-in-production`.** Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and paste it straight into the panel. Changing it invalidates existing refresh tokens, which is fine — everyone simply logs in again. |
| `PORT` | supplied | The platform injects it. `server.ts` listens on `0.0.0.0` at that port. Do not set it yourself. |
| `NODE_ENV` | optional | `production`. Only set it if the panel keeps it out of the install step, or keep the `--prod=false` in the Build Command (which is why it is there). |
| `CORS_ORIGIN` | no | Deliberately unnecessary: the browser and the API share an origin, so no request is cross-origin. Leave it unset rather than inventing a hostname. |
| `LOG_LEVEL` | no | Defaults to `info`. |
| `WEB_ROOT` | no | Defaults to `public/` beside `server.js`, which is the layout above. |

Locally, `apps/api/.env` holds the same names for development. It is gitignored and never ships.

## Migration policy

**The hosted database is live client data.** It is the same database development points at.

- Deployment **never** migrates as a side effect. Nothing at startup migrates, seeds or creates a
  schema — `server.ts` only builds the app and listens, so restarting the container repeatedly is
  always safe. `dist/db/migrate.js` and `dist/db/seed.js` exist in the image but nothing invokes
  them.
- Before deploying a schema change, compare `apps/api/drizzle/meta/_journal.json` with the applied
  rows in `drizzle.__drizzle_migrations`. Equal counts mean nothing is pending.
- If a migration **is** pending: review the generated SQL, confirm it is additive, and run
  `pnpm db:migrate` as its own approved step. `/deploy` stops and asks rather than doing it.
- Never `drizzle-kit push`, never reset, never drop, never seed. `db:seed` targets this database
  and `.claude/hooks/guard-bash.mjs` blocks it on purpose.
- If the state is ambiguous — hashes that do not line up, or the database ahead of the journal —
  **stop and report**. Do not guess.

As of the first deployment: 12 journal entries, 12 applied, nothing pending. The deployed commit
`ca96589` needs no migration beyond `0011`, which is already applied.

## Deploying

```powershell
# the deploy hook URL is a credential. Either this shell only:
$env:STUDIOCRM_DEPLOY_HOOK = '...'
# or paste it as STUDIOCRM_DEPLOY_HOOK=... into deploy/.env.deploy, which is gitignored.

.\deploy\Deploy-StudioCRM.ps1 -DryRun      # gates + report, contacts nothing
.\deploy\Deploy-StudioCRM.ps1 -Push        # push the branch, trigger, wait, verify
.\deploy\Deploy-StudioCRM.ps1 -VerifyOnly  # re-check what is already live
```

What it does, in order:

```
read config -> git preflight -> typecheck -> tests -> build -> (push) -> trigger hook
   -> wait for the live build SHA to become HEAD -> verify -> report
```

- It refuses to run while `appUrl` is `TODO`, and refuses to deploy a commit that is not on the
  remote branch the panel clones (unless `-Push` is given). Both are guesses it will not make.
- It **never pushes without `-Push`** and never commits.
- `erp-boilerplate.bundle` and `studio form image.pdf` are intentional untracked files; it ignores
  them and mentions anything else untracked only to say it will not be deployed.
- It never touches the database.

## What a failed deploy leaves behind

The container is replaced only by a build that succeeded, so a failed build leaves the **previous
application serving, whole**. There is no half-uploaded state to clean up — the reason the old
FTP model needed a careful upload order and this one does not.

If the live build SHA never becomes the pushed commit, the container build failed. Read the host's
log before changing anything:

```
FTPS  win8194.site4now.net  (explicit TLS, port 21)  user studiodev
      /node_app_automate_deploy_<id>.log
```

Failures seen so far:

| In the log | Cause | Fix |
| --- | --- | --- |
| `fatal: could not read Username for 'https://github.com'` | private repo, no Deployment Key | paste a GitHub PAT in the panel |
| `Unsupported URL Type "workspace:"` | the build ran under npm | Build Command must use `pnpm` |
| `vite: not found` / `tsc: not found` | devDependencies were pruned at install | keep `--prod=false` in the Build Command |

## Health verification

`GET /api/health` — public, unauthenticated, and deliberately thin:

```json
{ "message": "OK", "data": { "status": "up", "db": "up", "version": "ca96589", "builtAt": "...", "time": "..." } }
```

- `db` is only `up` or `down` — never the host, the user, the driver's message or a stack trace.
- `version` is the short commit the bundle was built from. That is how a deploy proves the rebuild
  actually took effect, and how anyone can tell which build is live. The client UI shows none of it.

The script also checks that a refresh on `/modules/billing/new` returns the app shell and that an
unknown `/api/...` path still returns a JSON 404.

Verified locally against the real bundle before the first deployment, with the host's own start
command:

```
GET /api/health           -> 200 {"status":"up","db":"up","version":"ca96589",...}
GET /api/no-such-route    -> 404 application/json
GET /modules/billing/new  -> 200 text/html   (app shell)
GET /assets/index-*.js    -> 200 public, max-age=31536000, immutable
```

## SPA routing

React routes (`/modules/billing`, `/modules/billing/new`, `/modules/billing/:id`,
`/modules/appointments`, `/modules/masters/*`) are not files. `apps/api/src/plugins/web.ts`
installs the fallback and `plugins/errors.ts` calls it: a GET that no API route claimed and no file
matches returns `index.html`, so a refresh or a pasted deep link works. Anything under `/api/`
stays a JSON 404, so a mistyped endpoint can never answer with HTML.

## Rollback

**Application rollback and database rollback are different things. Never conflate them.**

### Application

The image is built from a commit, so rolling back is choosing a different commit:

1. Point the panel's Git Branch at a branch or tag whose head is the previous commit (or reset the
   deploy branch to it), and trigger a rebuild.
2. Verify `/api/health` reports that commit.

Nothing needs restoring by hand, and the previous container keeps serving until the new one is
healthy.

### Database

**Migrations are not reversed automatically, and `/deploy` will not do it.** A schema change is
undone only by a new, reviewed, forward migration that is itself data-safe. Rolling the application
back does **not** roll the schema back, and does not need to: every migration in this project so
far is additive, so an older build runs unchanged against a newer schema.

If a migration ever were not additive, the rollback plan has to be designed with it, before it is
applied — not after.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Health never answers | The container is not running. Read the build log over FTPS (above). |
| `db: "down"` in health | `DATABASE_URL` is missing or wrong in the panel. Check that `@@` in the password is percent-encoded as `%40%40`. |
| Live `version` is not the commit you pushed | The panel cloned a different branch, the PAT is missing or expired, or the build failed. The log says which. |
| Deep link 404s with JSON | `apps/api/dist/public` was not in the image — `pnpm build` did not run `deploy/collect-dist.mjs`. |
| A page loads but every API call 404s | Something other than `server.js` is serving the static files. The Start Command must be `pnpm start`. |
| Login fails with a valid password | `JWT_SECRET` is unset, or differs from the one the existing refresh tokens were signed with. Log in again. |
| Nobody but Super Admin can open a module | Role grants are stored JSON written before the newer permissions existed. Open each role in Settings → Roles and save it. |

## Values that must come from the control panel

`deploy/deploy.config.json` carries `TODO` until this is read from the panel. **Do not guess it** —
a wrong `appUrl` makes the health check pass against somebody else's site.

| Config key | Where to look |
| --- | --- |
| `appUrl` | Websites → `studio` → Domains: the live domain, or the temporary URL the panel lists for the site |

Panel-side, and never stored here: the **GitHub PAT**, the **Deploy Hook URL**, and the
**environment variables** above.
