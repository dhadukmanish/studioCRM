#Requires -Version 5.1
<#
.SYNOPSIS
    Deploys StudioCRM to its SmarterASP.NET / Site4Now Node hosting, or verifies what is live.

.DESCRIPTION
    The host builds the app as a Linux container from a GIT CLONE of this repository. So a
    deployment is: get the commit onto the remote branch the panel clones, tell the panel to
    rebuild, then prove the live instance is running that exact commit.

    This script does the parts that can be automated and REFUSES to guess the parts that cannot.
    It never writes a credential anywhere: the GitHub token lives in the control panel, the
    deploy hook URL in $env:STUDIOCRM_DEPLOY_HOOK, and every application secret in the panel's
    environment variables.

    It never touches the database. Migrations are a separate, explicitly approved step.

.PARAMETER DryRun
    Run every local check and gate, report what would be deployed, then stop. Contacts nothing.

.PARAMETER VerifyOnly
    Skip the gates and the trigger; only re-check the live application.

.PARAMETER Push
    Allow the script to run `git push` for the configured branch. Without this it refuses to
    continue when HEAD is not already on the remote, rather than pushing behind your back.

.PARAMETER Force
    Continue even though tracked files are modified. A build that matches no commit cannot be
    reproduced or rolled back to, so this is deliberately awkward.

.EXAMPLE
    .\deploy\Deploy-StudioCRM.ps1 -DryRun

.EXAMPLE
    $env:STUDIOCRM_DEPLOY_HOOK = 'https://...'   # from the panel, this shell only
    .\deploy\Deploy-StudioCRM.ps1 -Push
#>
[CmdletBinding()]
param(
    [switch] $DryRun,
    [switch] $VerifyOnly,
    [switch] $Push,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configPath = Join-Path $repoRoot 'deploy\deploy.config.json'

function Write-Step { param([string] $Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string] $Text) Write-Host "    OK   $Text" -ForegroundColor Green }
function Write-Warn { param([string] $Text) Write-Host "    WARN $Text" -ForegroundColor Yellow }
function Fail       { param([string] $Text) Write-Host "`nSTOPPED: $Text" -ForegroundColor Red; exit 1 }

function Invoke-Native {
    param([string] $File, [string[]] $Arguments, [string] $What)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE). Nothing was deployed." }
}

# ---------------------------------------------------------------- configuration

Write-Step 'Reading deploy/deploy.config.json'
if (-not (Test-Path $configPath)) { Fail "deploy.config.json not found at $configPath" }
$config = Get-Content $configPath -Raw | ConvertFrom-Json

$appUrl = $config.appUrl
$branch = $config.git.branch
$healthPath = $config.healthPath

if ([string]::IsNullOrWhiteSpace($appUrl) -or $appUrl -eq 'TODO') {
    Fail @"
appUrl is still TODO, so there is nothing to verify against and no client-review link to hand over.

Read it from the control panel: Websites -> $($config.panel.site) -> Domains (the live domain, or
the temporary URL the panel lists for the site). Put it in deploy/deploy.config.json as appUrl.
Do not guess a hostname - a wrong one makes the health check pass against somebody else's site.
"@
}

$appUrl = $appUrl.TrimEnd('/')
Write-Ok "site $appUrl, branch $branch"

# ---------------------------------------------------------------- verify helpers

function Get-Health {
    param([int] $TimeoutSec = 20)
    try {
        $response = Invoke-WebRequest -Uri "$appUrl$healthPath" -UseBasicParsing -TimeoutSec $TimeoutSec
        return ($response.Content | ConvertFrom-Json).data
    } catch {
        return $null
    }
}

function Test-LiveApplication {
    param([string] $ExpectedCommit)

    Write-Step 'Verifying the live application'
    $health = Get-Health
    if ($null -eq $health) { Fail "$appUrl$healthPath did not answer. The application is not serving." }

    Write-Ok "health: status=$($health.status) db=$($health.db) version=$($health.version) builtAt=$($health.builtAt)"
    if ($health.db -ne 'up') {
        Write-Warn 'db is down - DATABASE_URL is missing or wrong in the panel environment variables. Nothing in the app will work past the login screen.'
    }
    if ($ExpectedCommit -and $health.version -ne $ExpectedCommit) {
        Fail "live build is $($health.version) but $ExpectedCommit was deployed. The host has not rebuilt, or it cloned a different branch."
    }

    # A SPA deep link must return the app shell, not a JSON 404.
    $spa = Invoke-WebRequest -Uri "$appUrl/modules/billing/new" -UseBasicParsing -TimeoutSec 20
    if ($spa.Headers['Content-Type'] -notlike 'text/html*') { Fail "a refresh on /modules/billing/new returned $($spa.Headers['Content-Type']) instead of the app shell." }
    Write-Ok 'SPA deep link returns the app shell'

    # An unknown API path must stay JSON, so a mistyped endpoint can never answer with HTML.
    $apiStatus = 0
    $apiType = ''
    try {
        $probe = Invoke-WebRequest -Uri "$appUrl/api/no-such-route" -UseBasicParsing -TimeoutSec 20
        $apiStatus = $probe.StatusCode
        $apiType = $probe.Headers['Content-Type']
    } catch {
        $apiStatus = [int] $_.Exception.Response.StatusCode
        $apiType = $_.Exception.Response.ContentType
    }
    if ($apiStatus -ne 404 -or $apiType -notlike 'application/json*') { Fail "an unknown /api path answered $apiStatus $apiType - it must be a JSON 404." }
    Write-Ok 'unknown /api path is still a JSON 404'
}

if ($VerifyOnly) {
    Test-LiveApplication -ExpectedCommit ''
    Write-Host "`nVerified. Client review URL: $appUrl" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- git preflight

Write-Step 'Checking the working tree'
Push-Location $repoRoot
try {
    $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -ne $branch) {
        Fail "you are on '$currentBranch' but the panel clones '$branch'. Switch branch, or change git.branch in deploy.config.json AND in the panel - the two must agree."
    }

    $dirty = & git status --porcelain --untracked-files=no
    if ($dirty) {
        Write-Host ($dirty -join "`n")
        if (-not $Force) { Fail 'tracked files are modified. A deployed build that matches no commit cannot be reproduced or rolled back to. Commit them, or re-run with -Force.' }
        Write-Warn 'deploying with a dirty tree because -Force was given. The container will still build the COMMIT, not your edits.'
    } else {
        Write-Ok 'tracked files clean'
    }

    # erp-boilerplate.bundle and "studio form image.pdf" are intentional untracked files.
    # They are never staged and never a problem - only anything ELSE untracked is worth a word.
    $known = @('erp-boilerplate.bundle', 'studio form image.pdf')
    $untracked = @(& git ls-files --others --exclude-standard | Where-Object { $known -notcontains $_ })
    if ($untracked.Count -gt 0) {
        Write-Warn "untracked files that will NOT be deployed (the container builds the commit): $($untracked -join ', ')"
    }

    $commit = (& git rev-parse --short HEAD).Trim()
    $subject = (& git log -1 --pretty=%s).Trim()
    Write-Ok "HEAD $commit  $subject"

    $unpushed = @(& git rev-list "origin/$branch..HEAD" 2>$null)
    $remoteHasBranch = $LASTEXITCODE -eq 0
    if (-not $remoteHasBranch) {
        if (-not $Push) { Fail "origin/$branch does not exist yet, so the panel has nothing to clone. Re-run with -Push, or push it yourself." }
        Write-Warn "origin/$branch does not exist - it will be created"
        $unpushed = @(& git rev-list HEAD)
    }
    if ($unpushed.Count -gt 0 -and -not $Push) {
        Fail "$($unpushed.Count) commit(s) are not on origin/$branch, so the host would build an older tree. Re-run with -Push, or push yourself first."
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- gates

Write-Step 'Quality gates: typecheck, tests, build'
Push-Location $repoRoot
try {
    Invoke-Native -File 'pnpm' -Arguments @('typecheck') -What 'pnpm typecheck'
    Invoke-Native -File 'pnpm' -Arguments @('test') -What 'pnpm test'
    Invoke-Native -File 'pnpm' -Arguments @('build') -What 'pnpm build'
} finally {
    Pop-Location
}
Write-Ok 'typecheck, tests and build all passed'

$bundle = Join-Path $repoRoot 'apps\api\dist\server.js'
$shell = Join-Path $repoRoot 'apps\api\dist\public\index.html'
if (-not (Test-Path $bundle)) { Fail 'apps/api/dist/server.js was not produced.' }
if (-not (Test-Path $shell)) { Fail 'apps/api/dist/public/index.html was not produced - deploy/collect-dist.mjs did not run.' }
Write-Ok 'local build produces one runnable folder (server.js + public/)'

Write-Step 'Migration state'
Write-Host '    This script does NOT migrate. Compare apps/api/drizzle/meta/_journal.json with the'
Write-Host '    applied rows in drizzle.__drizzle_migrations before deploying a schema change, and'
Write-Host '    run pnpm db:migrate as its own approved step. The database is live client data.'

if ($DryRun) {
    Write-Host "`nDry run complete. Would deploy $commit ($subject) to $appUrl via branch $branch." -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- push

if ($Push) {
    Write-Step "Pushing $branch to origin"
    Push-Location $repoRoot
    try {
        Invoke-Native -File 'git' -Arguments @('push', '-u', 'origin', $branch) -What "git push origin $branch"
    } finally {
        Pop-Location
    }
    Write-Ok "origin/$branch now has $commit"
} else {
    Write-Ok "origin/$branch already has $commit"
}

# ---------------------------------------------------------------- trigger

$hook = $env:STUDIOCRM_DEPLOY_HOOK
if ([string]::IsNullOrWhiteSpace($hook)) {
    Write-Step 'Triggering the rebuild'
    Write-Warn '$env:STUDIOCRM_DEPLOY_HOOK is not set, so the rebuild cannot be triggered from here.'
    Write-Host '    Click Deploy Now in the control panel (Websites -> studio -> the Node app page),'
    Write-Host '    or create a deploy hook there and set $env:STUDIOCRM_DEPLOY_HOOK to its URL.'
    Write-Host '    This script will now wait for the live build to become the pushed commit.'
} else {
    Write-Step 'Triggering the rebuild through the deploy hook'
    try {
        Invoke-WebRequest -Uri $hook -Method Post -UseBasicParsing -TimeoutSec 60 | Out-Null
        Write-Ok 'deploy hook accepted the request'
    } catch {
        Fail "the deploy hook returned an error: $($_.Exception.Message). Nothing was deployed; the previous build is still serving."
    }
}

# ---------------------------------------------------------------- wait, then verify

Write-Step "Waiting for the live build to become $commit"
$deadline = (Get-Date).AddMinutes(12)
$seen = ''
while ((Get-Date) -lt $deadline) {
    $health = Get-Health -TimeoutSec 10
    if ($null -ne $health) {
        if ($health.version -eq $commit) {
            Write-Ok "live build is $commit"
            break
        }
        if ($health.version -ne $seen) {
            $seen = $health.version
            Write-Host "    live build is still $seen ..."
        }
    }
    Start-Sleep -Seconds 15
}

$final = Get-Health
if ($null -eq $final -or $final.version -ne $commit) {
    $what = 'no answer'
    if ($null -ne $final) { $what = $final.version }
    Fail @"
the live build did not become $commit within 12 minutes (it reports: $what).

The container build most likely failed. The host writes its build log to the site root over FTPS
as node_app_automate_deploy_<id>.log - read it before changing anything. docs/DEPLOYMENT.md has
the failure modes that have actually happened, including a private-repo clone with no token.

Nothing was lost: the previous build is still serving.
"@
}

Test-LiveApplication -ExpectedCommit $commit

Write-Host "`nDeployed $commit ($subject)." -ForegroundColor Green
Write-Host "Client review URL: $appUrl" -ForegroundColor Green
