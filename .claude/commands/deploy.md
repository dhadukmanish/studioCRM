---
description: Deploy StudioCRM to its Node hosting — preflight, gates, push, rebuild, live verification
argument-hint: "[dry-run | verify | rollback]"
---

You are deploying StudioCRM to the client-review environment on SmarterASP.NET / Site4Now.
Read `docs/DEPLOYMENT.md` first — it is the contract this command follows.

**The host builds in a Linux container from a git clone and runs on Windows under IIS.** A
deployment is therefore: get the commit onto the branch the panel clones, trigger a rebuild, put
`web.config` back, and prove the live instance reports that exact commit.

Two things about this host decide almost every failure, so know them before starting:

- **`web.config` is what starts the app**, not the panel's Start Command. Its `<httpPlatform>`
  element names `node.exe` and `apps\api\dist\server.js` and passes `PORT=%HTTP_PLATFORM_PORT%`.
- **The host overwrites `web.config` on every deploy** with a version that has no `<httpPlatform>`
  element, which is a 502 on every path — including `/api/health`. Re-applying `deploy/web.config`
  is a required step, not a workaround. `-FixWebConfig` does it.

`$ARGUMENTS` selects the mode:

- empty → a full deployment
- `dry-run` → local checks and gates only, then stop and report what would be deployed
- `verify` → only re-run the live checks against what is already deployed
- `rollback` → point the deploy branch at the previous commit (see **Rollback** below)

## The rules this deployment never breaks

1. **The database is live client data.** Never run `db:seed`, never reset, never drop, never
   `drizzle-kit push`. Deployment does not migrate as a side effect: a pending migration is a
   separate, explicitly approved step (step 5).
2. **No secret is ever written down.** The deploy hook URL and the FTP password come from
   `$env:STUDIOCRM_DEPLOY_HOOK` / `$env:STUDIOCRM_FTP_PASSWORD` or from `deploy/.env.deploy`, which
   is gitignored. `DATABASE_URL` and `JWT_SECRET` live in the site-root `.env`, uploaded by hand. A
   GitHub PAT, if ever needed, is pasted into the panel by the user. None of them goes into a commit,
   a doc, a log, a command line you echo, or your report.
3. **`erp-boilerplate.bundle` and `studio form image.pdf` are intentional untracked files.** Never
   staged, never mentioned as a problem.
4. **Pushing is explicit.** The container builds what is on the remote, so a deploy needs the
   commit pushed — but never push, and never commit, without the user asking in this session.
   `-Push` is how the script is told it may.
5. **Stop on the first failure.** A failed typecheck, test, build, clone, build-in-container or
   health check ends the run. Never "try again without the tests".
6. **Full deployment, not `-Hotfix`,** whenever the release changes the web bundle, API routes,
   migrations, fonts/WASM or dependencies. `-Hotfix` uploads server.js only — it is for a server-only
   emergency fix on a tree that was already fully deployed. The surrounding lifecycle (gates, commit
   hygiene, migration review, env preservation, smoke test) is the `studio-release` skill.
7. **Do not guess a hosting value.** If `appUrl` is `TODO`, or the branch in the panel and in
   `deploy.config.json` disagree, stop and say exactly which panel value is needed and where it is.

## Steps

### 1. Read the deployment configuration

Read `deploy/deploy.config.json`. If `appUrl` is still `TODO`, **stop immediately** and tell the
user to read it from Websites → `studio` → Domains. Do not probe hostnames hoping one resolves.

Confirm the panel is expected to hold: Git Branch = `git.branch` from that config, Build Command =
`build.command`, Start Command = `build.start`, a PAT (the repo is private), and the environment
variables `docs/DEPLOYMENT.md` lists.

### 2. Check the working tree

Run `git status --porcelain --untracked-files=no`, `git log --oneline -3`, and
`git rev-list --count origin/<branch>..HEAD`.

- Clean and nothing unpushed → report the commit about to be deployed.
- Tracked files modified → **warn clearly and ask**. A deployed build that matches no commit
  cannot be reproduced or rolled back to. Note that the container builds the **commit**, so
  uncommitted edits would silently not be deployed at all.
- Commits unpushed → say how many and that the deploy needs them pushed. Ask before pushing.
- On a different branch than the panel clones → stop; the two must agree.

### 3. Quality gates

`pnpm typecheck`, then `pnpm test`, then `pnpm build`. All three must pass; report the test counts.
Then confirm the build produced one runnable folder: `apps/api/dist/server.js` **and**
`apps/api/dist/public/index.html`. A missing `public/` means `deploy/collect-dist.mjs` did not run,
and the deployed app would answer deep links with JSON.

### 4. Prove the bundle locally before shipping it

Start `apps/api/dist/server.js` on a spare port with the env vars supplied from outside (as the
container does) and check: `/api/health` returns `db: up` and the expected `version`, an unknown
`/api/...` path is a JSON 404, and `/modules/billing/new` returns the app shell. This catches a
broken bundle before the host does, and costs seconds. Kill the process afterwards.

### 5. Migration state — check, never assume

Compare `apps/api/drizzle/meta/_journal.json` with the applied rows in
`drizzle.__drizzle_migrations`.

- Counts equal → nothing pending. Say so and continue.
- Journal ahead → **stop and report which ones.** Show the SQL, confirm it is additive, and run
  `pnpm db:migrate` only after the user approves. Never as part of a deploy.
- Database ahead, or hashes that do not line up → **stop and report**. Do not guess.

### 6. Deploy

```powershell
$env:STUDIOCRM_DEPLOY_HOOK  = '...'         # from the panel, this shell only
$env:STUDIOCRM_FTP_PASSWORD = '...'         # only needed to re-apply web.config

.\deploy\Deploy-StudioCRM.ps1 -DryRun
.\deploy\Deploy-StudioCRM.ps1 -Push
.\deploy\Deploy-StudioCRM.ps1 -FixWebConfig
.\deploy\Deploy-StudioCRM.ps1 -VerifyOnly
```

The script pushes (only with `-Push`), calls the deploy hook, then polls `/api/health` until the
live `version` equals the pushed commit. Without the hook in the environment it says so and waits
while the user clicks **Deploy Now** in the panel.

**This is not a zero-downtime deployment, and do not describe it as one.** The host extracts the new
tree over the site folder and then rewrites `web.config`, so between "the host finished" and
"`web.config` is repaired" the whole site is a 502. Say so before deploying, and deploy when a few
minutes of downtime is acceptable.

If the live SHA never becomes the pushed commit, read the host's own logs over FTPS before changing
anything — `/node_app_automate_deploy_<id>.log` ends with an explicit SUCCESS or failure, and
`/logs/node.log` holds the Node process's own output. A `SUCCESS` with a 502 means `web.config`, not
the build. `docs/DEPLOYMENT.md` lists the failures that have actually happened.

### 7. Verify the live application

The script checks health (`status`, `db`, and that the live SHA matches), the SPA deep link, and
the JSON 404. Then verify in a browser against the real URL:

- the login page loads over **https**, and login works
- the nav renders: Item Master, Sub Item Master, Account Group, Account Master, Book Master,
  Appointments, Billing
- a bill opens: book picker, item/product lookups, GST per line, the discount control, With/Without
  GST, and the GST Details table
- **no request goes to localhost**, no mixed content, no CORS error, no console errors

**Read-only by default.** The hosted database holds genuine client records. Do not create, edit or
delete business data to prove the app works. If a write really must be tested, ask first, tag what
you create so it is unmistakable, and delete exactly those rows afterwards.

### 8. Report

1. commit deployed (SHA + subject) and the live build SHA from `/api/health`
2. the client-review URL
3. gates: typecheck / tests / build, and the local bundle check
4. migration state — pending or clean
5. verification results, including the SPA refresh and API routing
6. rollback pointer: the commit the deploy branch pointed at before this run
7. `git status` at the end

Never print the deploy hook URL, the PAT, `DATABASE_URL`, `JWT_SECRET` or any other credential.

## Rollback

Application and database rollback are **not** the same thing.

- **Application**: point the deploy branch at the previous commit (or a tag on it), trigger a
  rebuild, re-apply `web.config`, and verify `/api/health` reports that SHA. It is a rebuild, not a
  restore, and it costs the same downtime as any other deploy. Never force-push to do it without the
  user's explicit approval. If an extraction itself went wrong, the host keeps the previous tree in
  the site root as `production_studio_<id>.tar.gz.backup`.
- **Database**: never reversed automatically. A migration is rolled back only by a new, reviewed,
  forward migration. `docs/DEPLOYMENT.md` explains why.

The user speaks Hindi/Hinglish — reply in the language they use.
