#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# StudioCRM deploy, CI form — what deploy/Deploy-StudioCRM.ps1 does after a push, run by
# .github/workflows/deploy.yml: optionally trigger the host, wait for it to finish, put back the
# web.config it breaks, and prove the live build is this commit. See docs/DEPLOYMENT.md.
#
# Secrets arrive only as environment variables (GitHub Actions secrets) and are never echoed:
#   STUDIOCRM_FTP_PASSWORD  required  FTPS password of the site's FTP user (deploy.config.json)
#   STUDIOCRM_DEPLOY_HOOK   optional  panel deploy hook; empty = GitHub's webhook starts the build
# Other inputs: GITHUB_SHA (the commit to expect), DEPLOY_T0 (epoch the build was started, for
# finding the host's log), DEADLINE_MIN (default 30).
#
# The repository is public, so this job's log is too: it prints states and file NAMES only —
# never a credential, a hook response body or the host's own logs.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

CONFIG=deploy/deploy.config.json
cfg() { jq -r "$1" "$CONFIG" | tr -d '\r'; }
APP_URL=$(cfg .appUrl); APP_URL=${APP_URL%/}
HEALTH_URL="$APP_URL$(cfg .healthPath)"
FTP_HOST=$(cfg .logs.host)
FTP_USER=$(cfg .logs.username)
FTP="ftp://$FTP_HOST"
SHA=${GITHUB_SHA:?GITHUB_SHA is required}
DEADLINE_MIN=${DEADLINE_MIN:-30}
T0=${DEPLOY_T0:-}
[[ $T0 =~ ^[0-9]+$ ]] || T0=$(date +%s)

log()  { echo "==> $*"; }
fail() { echo "::error::$*"; summary "**Failed:** $*"; exit 1; }
summary() { [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }

[[ -n ${STUDIOCRM_FTP_PASSWORD:-} ]] || fail "secret STUDIOCRM_FTP_PASSWORD is not set, so web.config cannot be repaired after the host's deploy (docs/DEPLOYMENT.md, Automatic deploy)."

# FTPS credentials go into a private curl config file — never onto a command line.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CURLCFG="$WORK/ftp.curlrc"
umask 077
pw=${STUDIOCRM_FTP_PASSWORD//\\/\\\\}; pw=${pw//\"/\\\"}
printf 'user = "%s:%s"\nssl-reqd\nsilent\nshow-error\nconnect-timeout = 20\nmax-time = 90\n' "$FTP_USER" "$pw" > "$CURLCFG"
unset pw
# Explicit TLS on port 21, as the server's FEAT advertises. A refused login (curl 67) stops the job at
# once: retrying a wrong password every 20 seconds for half an hour could get the FTP account locked.
ftp() {
  local rc=0
  curl -K "$CURLCFG" "$@" || rc=$?
  (( rc != 67 )) || fail "the FTP server refused the login for $FTP_USER — check the STUDIOCRM_FTP_PASSWORD secret."
  return $rc
}

# ------------------------------------------------------------------- live state
live_version() { curl -s -m 10 "$HEALTH_URL" | jq -r '.data.version // empty' 2>/dev/null | tr -d '\r' || true; }
# The build stamps `git rev-parse --short HEAD`, so the live version is a prefix of the full SHA.
is_live() { local v; v=$(live_version); [[ ${#v} -ge 7 && $SHA == "$v"* ]]; }

# ------------------------------------------------------------------- 1. trigger
trigger() {
  if [[ -z ${STUDIOCRM_DEPLOY_HOOK:-} ]]; then
    log "STUDIOCRM_DEPLOY_HOOK is empty: not triggering — GitHub's repository webhook (or the panel) starts the build on push"
    return
  fi
  log "triggering the host rebuild through the deploy hook"
  local body
  body=$(curl -sS -m 60 -X POST -H 'Content-Type: application/json' -H 'X-GitHub-Event: push' \
    --data-binary "@${GITHUB_EVENT_PATH:-/dev/null}" "$STUDIOCRM_DEPLOY_HOOK" 2>/dev/null) || fail "the deploy hook did not answer."
  # It answers HTTP 200 even when it refuses, and says so only in the body.
  if grep -q '"state" *: *"ERROR"' <<<"$body"; then
    fail "the deploy hook refused the request (HTTP 200 with state ERROR — it only accepts GitHub's own signed delivery). Empty the STUDIOCRM_DEPLOY_HOOK secret and register the hook URL as a repository webhook instead (docs/DEPLOYMENT.md)."
  fi
  log "deploy hook accepted the request"
}

# ------------------------------------------------------------------- 2. host progress
# The host's deploy log for THIS run: the newest node_app_automate_deploy_*.log written since T0.
find_deploy_log() {
  local name t best='' best_t=0
  while IFS= read -r name; do
    name=${name%$'\r'}
    [[ $name == node_app_automate_deploy_*.log ]] || continue
    t=$(ftp -I "$FTP/$name" 2>/dev/null | tr -d '\r' | sed -n 's/^[Ll]ast-[Mm]odified: //p')
    t=$(date -u -d "$t" +%s 2>/dev/null || echo 0)
    if (( t >= T0 - 120 && t > best_t )); then best=$name; best_t=$t; fi
  done < <(ftp --list-only "$FTP/" 2>/dev/null || true)
  echo "$best"
}

# 3. The host rewrites web.config at the very END of its run, into a file with no <httpPlatform>
# (a 502 everywhere). Uploading only when the remote file is the host's version means the upload
# always lands AFTER the rewrite — never clobbered by it — and is repeated if it happens again.
webconfig_broken() {
  ftp -o "$WORK/web.config.remote" "$FTP/web.config" 2>/dev/null || return 1   # unreadable: decide next round
  ! grep -q 'processPath=' "$WORK/web.config.remote"
}

# ------------------------------------------------------------------- run
log "deploying ${SHA:0:7} to $APP_URL"
summary "### StudioCRM deploy \`${SHA:0:7}\`"
trigger

if is_live; then
  log "the live build is already ${SHA:0:7}"
else
  # One login up front, in this shell, so a wrong password stops the job after a single attempt.
  ftp --list-only "$FTP/" > /dev/null || fail "could not reach the FTP server $FTP_HOST."
  deadline=$(( $(date +%s) + DEADLINE_MIN * 60 ))
  host_log=''; host_done=0; repairs=0; last=''
  until is_live; do
    (( $(date +%s) < deadline )) || fail "the live build did not become ${SHA:0:7} within $DEADLINE_MIN minutes (host log: ${host_log:-none found}, host SUCCESS: $host_done, web.config repairs: $repairs). Read the host's deploy log and logs/node.log over FTPS (docs/DEPLOYMENT.md)."

    if [[ -z $host_log ]]; then
      host_log=$(find_deploy_log)
      [[ -n $host_log ]] && log "host deploy log: $host_log"
    fi
    if [[ -n $host_log && $host_done == 0 ]] && ftp -o "$WORK/deploy.log" "$FTP/$host_log" 2>/dev/null; then
      if grep -q 'SUCCESS' "$WORK/deploy.log"; then
        host_done=1; log "host reports SUCCESS — files extracted"
      elif tail -n 5 "$WORK/deploy.log" | grep -qiE '\b(failed|failure)\b'; then
        fail "the host's deploy log $host_log ends in a failure — read it over FTPS. The previous build is still on the server."
      fi
    fi

    if webconfig_broken; then
      log "host has rewritten web.config without <httpPlatform> — uploading deploy/web.config"
      ftp -T deploy/web.config "$FTP/web.config" || fail "uploading web.config failed."
      repairs=$((repairs + 1))
      sleep 15
      continue
    fi

    v=$(live_version); [[ $v != "$last" ]] && { log "live build is ${v:-not answering} ..."; last=$v; }
    sleep 20
  done
  log "live build is ${SHA:0:7} (web.config repairs: $repairs)"
fi

# ------------------------------------------------------------------- 4. verify (as -VerifyOnly)
db=$(curl -s -m 20 "$HEALTH_URL" | jq -r '.data.db // empty' | tr -d '\r')
[[ $db == up ]] || echo "::warning::health reports db=${db:-missing} — DATABASE_URL in the site-root .env is missing or wrong."
spa=$(curl -s -o /dev/null -m 20 -w '%{content_type}' "$APP_URL/modules/billing/new")
[[ $spa == text/html* ]] || fail "a refresh on /modules/billing/new returned '$spa' instead of the app shell."
api=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{content_type}' "$APP_URL/api/no-such-route")
[[ $api == "404 application/json"* ]] || fail "an unknown /api path answered '$api' — it must be a JSON 404."
log "verified: health up, SPA deep link, JSON 404"
summary "Live at $APP_URL — build \`${SHA:0:7}\`, db \`$db\`."
