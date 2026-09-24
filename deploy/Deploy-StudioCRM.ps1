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

.PARAMETER Hotfix
    Upload the locally built apps\api\dist\server.js over the deployed one, repair web.config, and
    stop. A stopgap for when the host's pipeline cannot be triggered but the site must come back:
    it changes only the server bundle, so it is safe exactly when the web assets are unchanged
    between the deployed commit and HEAD. The next real deploy replaces it with the tree from git.
    It does NOT run the gates - build first, or you are shipping something untested.

.PARAMETER FixWebConfig
    Upload deploy/web.config to the site root over FTPS and stop. The host's deploy step rewrites
    web.config and its version has no <httpPlatform> element, so IIS is left with nothing to start
    and every request is a 502. A full deploy does this automatically once the host has finished;
    this switch is the same repair on its own.

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
    [switch] $Force,
    [switch] $FixWebConfig,
    [switch] $Hotfix
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

# ---------------------------------------------------------------- local secrets

<#
    Credentials come from the environment, or from deploy/.env.deploy, which is gitignored
    precisely so they can be kept out of a shell history, a commit and a chat message. Nothing
    here is ever echoed: only the NAME of what was found is reported.
#>
function Get-LocalSecret {
    param([string] $Name)

    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { return $fromEnv }

    $file = Join-Path $repoRoot 'deploy\.env.deploy'
    if (Test-Path $file) {
        foreach ($line in Get-Content $file) {
            if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.+?)\s*$") {
                return $Matches[1].Trim('"').Trim("'")
            }
        }
    }
    return $null
}

<#
    Uploads one local file to the site root over explicit FTPS. This is NOT how the application is
    deployed - the host's own pipeline does that from a git clone. It exists for exactly one file:
    the web.config the host breaks on every deploy.
#>
function Send-ToSiteRoot {
    param([string] $LocalPath, [string] $RemoteName)

    $logs = $config.logs
    $password = Get-LocalSecret 'STUDIOCRM_FTP_PASSWORD'
    if ([string]::IsNullOrWhiteSpace($password)) {
        $secure = Read-Host -Prompt "FTP password for $($logs.username)@$($logs.host)" -AsSecureString
        $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    if ([string]::IsNullOrWhiteSpace($password)) { Fail 'no FTP password available, so web.config cannot be repaired.' }

    $request = [Net.FtpWebRequest]::Create("ftp://$($logs.host)/$RemoteName")
    $request.Method = [Net.WebRequestMethods+Ftp]::UploadFile
    $request.Credentials = New-Object Net.NetworkCredential($logs.username, $password)
    $request.EnableSsl = $true          # explicit TLS: the server's FEAT advertises AUTH TLS
    $request.UseBinary = $true
    $request.UsePassive = $true
    $request.KeepAlive = $false
    $request.Timeout = 60000

    $bytes = [IO.File]::ReadAllBytes($LocalPath)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Close()
    }
    $response = $request.GetResponse()
    try {
        Write-Ok "uploaded $RemoteName ($($bytes.Length) bytes) - $($response.StatusDescription.Trim())"
    } finally {
        $response.Close()
    }
}

function Repair-WebConfig {
    Write-Step 'Repairing web.config in the site root'
    $local = Join-Path $repoRoot 'deploy\web.config'
    if (-not (Test-Path $local)) { Fail "deploy/web.config is missing - it is the only thing that tells IIS which process to start." }
    Send-ToSiteRoot -LocalPath $local -RemoteName 'web.config'
}

if ($FixWebConfig) {
    Repair-WebConfig
    Write-Host "`nweb.config replaced. Give IIS a few seconds, then run with -VerifyOnly." -ForegroundColor Green
    exit 0
}

if ($Hotfix) {
    $bundlePath = Join-Path $repoRoot 'apps\api\dist\server.js'
    if (-not (Test-Path $bundlePath)) { Fail 'apps/api/dist/server.js does not exist - run pnpm build first.' }

    Write-Step 'Hotfix: replacing only the deployed server bundle'
    Write-Warn 'this bypasses the host pipeline, so the server tree will not match the deployed commit until the next real deploy'
    Send-ToSiteRoot -LocalPath $bundlePath -RemoteName 'apps/api/dist/server.js'
    Repair-WebConfig
    Write-Host "`nBundle and web.config replaced. Give IIS up to a minute, then run with -VerifyOnly." -ForegroundColor Green
    exit 0
}

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

# A health payload from an OLDER build may not carry db, version or builtAt at all - which is
# exactly the situation while waiting for a rebuild to replace such a build. Under Set-StrictMode
# reaching for a missing property is a terminating error, so every read goes through this.
function Get-Prop {
    param($Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-LiveApplication {
    param([string] $ExpectedCommit)

    Write-Step 'Verifying the live application'
    $health = Get-Health
    if ($null -eq $health) { Fail "$appUrl$healthPath did not answer. The application is not serving." }

    $status = Get-Prop $health 'status'
    $dbState = Get-Prop $health 'db'
    $liveCommit = Get-Prop $health 'version'
    $builtAt = Get-Prop $health 'builtAt'
    Write-Ok "health: status=$status db=$dbState version=$liveCommit builtAt=$builtAt"

    if ($dbState -ne 'up') {
        Write-Warn 'db is not up - DATABASE_URL is missing or wrong in the panel environment variables. Nothing in the app will work past the login screen.'
    }
    if ($ExpectedCommit -and $liveCommit -ne $ExpectedCommit) {
        Fail "live build is '$liveCommit' but $ExpectedCommit was deployed. The host has not rebuilt, or it cloned a different branch."
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

# The hook URL is a credential: anyone holding it can trigger a rebuild. It comes from the
# environment, or from deploy/.env.deploy, which is gitignored precisely so it can be pasted
# into a file instead of into a shell history or a chat message.
$hook = Get-LocalSecret 'STUDIOCRM_DEPLOY_HOOK'
if ([string]::IsNullOrWhiteSpace($hook)) {
    Write-Step 'Triggering the rebuild'
    Write-Warn '$env:STUDIOCRM_DEPLOY_HOOK is not set, so the rebuild cannot be triggered from here.'
    Write-Host '    Click Deploy Now in the control panel (Websites -> studio -> the Node app page),'
    Write-Host '    or create a deploy hook there and set $env:STUDIOCRM_DEPLOY_HOOK to its URL.'
    Write-Host '    This script will now wait for the live build to become the pushed commit.'
} else {
    Write-Step 'Triggering the rebuild through the deploy hook'
    try {
        # The hook answers 200 even when it refuses the request, and says so only in the body:
        # {"job":{"msg":"Invalid","state":"ERROR",...}}. Ignoring the body wasted a whole deploy
        # cycle waiting for a build that had never started.
        $response = Invoke-WebRequest -Uri $hook -Method Post -UseBasicParsing -TimeoutSec 60
        $body = $response.Content
        if ($body -match '"state"\s*:\s*"ERROR"') {
            Fail @"
the deploy hook refused the request: $($body.Trim())

It is a GitHub webhook receiver and will not act on a hand-made POST - it has only ever been seen
to accept a real delivery from GitHub. Click Deploy Now in the control panel instead, or wire this
URL into the repository's webhook settings so a push triggers it. Nothing was deployed.
"@
        }
        Write-Ok 'deploy hook accepted the request'
    } catch {
        Fail "the deploy hook returned an error: $($_.Exception.Message). Nothing was deployed; the previous build is still serving."
    }
}

# ---------------------------------------------------------------- wait, then verify

Write-Step "Waiting for the live build to become $commit"
Write-Host '    The host extracts the build onto the Windows site folder and then rewrites'
Write-Host '    web.config into a version with no <httpPlatform> element, which is a 502 on every'
Write-Host '    request. So a 502 here means the deploy FINISHED; web.config is re-applied once.'

<#
    Timing matters here, and getting it wrong wasted a deploy: repairing web.config too early is
    useless, because the host rewrites it at the very END of its run. Observed on this host, a
    deploy takes about seven minutes from trigger to extracted files.

    So: do not touch web.config for the first few minutes. After that, re-upload it whenever the
    site is not answering, every REPAIR_EVERY seconds. The upload is idempotent, so repeating it is
    harmless, and it removes the need to guess the exact moment the host finishes.
#>
$QUIET_PERIOD = New-TimeSpan -Minutes 5
$REPAIR_EVERY = New-TimeSpan -Seconds 90

$started = Get-Date
$deadline = $started.AddMinutes(25)
$seen = ''
$lastRepair = $null

while ((Get-Date) -lt $deadline) {
    $health = Get-Health -TimeoutSec 10
    $liveCommit = Get-Prop $health 'version'
    if ($liveCommit -eq $commit) {
        Write-Ok "live build is $commit"
        break
    }

    $elapsed = (Get-Date) - $started
    $silent = $null -eq $health
    $quietPassed = $elapsed -gt $QUIET_PERIOD
    $dueAgain = ($null -eq $lastRepair) -or (((Get-Date) - $lastRepair) -gt $REPAIR_EVERY)

    if ($silent -and $quietPassed -and $dueAgain) {
        Write-Warn "site not answering after $([int]$elapsed.TotalMinutes) min - re-applying web.config"
        Repair-WebConfig
        $lastRepair = Get-Date
        Start-Sleep -Seconds 20
        continue
    }

    if ($liveCommit -ne $seen) {
        $seen = $liveCommit
        $label = $seen
        if ([string]::IsNullOrEmpty($label)) { $label = 'not reporting a commit yet' }
        Write-Host "    live build is still $label ..."
    }
    Start-Sleep -Seconds 15
}

$final = Get-Health
$finalCommit = Get-Prop $final 'version'
if ($finalCommit -ne $commit) {
    $what = 'no answer'
    if ($null -ne $final) { $what = "version '$finalCommit'" }
    Fail @"
the live build did not become $commit within 20 minutes (it reports: $what).

Read the host's own log before changing anything - it is written to the site root and reachable
over FTPS as node_app_automate_deploy_<id>.log, and it ends with an explicit SUCCESS or failure.
If it says SUCCESS, the build is on the server and the problem is IIS starting it: check
.\logs\node.log in the site root, and that web.config still has its <httpPlatform> element.
docs/DEPLOYMENT.md lists the failures that have actually happened.
"@
}

Test-LiveApplication -ExpectedCommit $commit

Write-Host "`nDeployed $commit ($subject)." -ForegroundColor Green
Write-Host "Client review URL: $appUrl" -ForegroundColor Green
