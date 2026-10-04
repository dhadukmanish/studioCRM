#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# StudioCRM deploy, CI form — run by .github/workflows/deploy.yml after it has tested and built
# this commit. It uploads the built server (apps/api/dist: one self-contained bundle + the web
# build, no node_modules) to the site over FTPS, then deploy/web.config, which makes IIS restart
# Node on the new bundle, and fails unless /api/health reports this commit. The host's own git
# pipeline is not used: it takes ~7 minutes and breaks web.config every time. See
# docs/DEPLOYMENT.md, "Automatic deploy".
#
# The one secret arrives as an environment variable (a GitHub Actions secret) and is never echoed:
#   STUDIOCRM_FTP_PASSWORD  FTPS password of the site's FTP user (deploy.config.json)
# The repository is public, so this job's log is too: it prints file names and states only.
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
SHORT=${SHA:0:7}
DIST=apps/api/dist

log()  { echo "==> $*"; }
summary() { [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }
fail() { echo "::error::$*"; summary "**Failed:** $*"; exit 1; }

[[ -n ${STUDIOCRM_FTP_PASSWORD:-} ]] || fail "secret STUDIOCRM_FTP_PASSWORD is not set (docs/DEPLOYMENT.md, Automatic deploy)."
[[ -f $DIST/server.js && -f $DIST/public/index.html ]] || fail "$DIST is not built — the Build step must run first."
grep -qF "VERSION = { commit: \"$SHORT\"" "$DIST/server.js" || fail "$DIST/server.js was not built from $SHORT (BUILD_COMMIT) — refusing to upload a bundle that would report another version."

# FTPS credentials go into a private curl config file — never onto a command line.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CURLCFG="$WORK/ftp.curlrc"
umask 077
pw=${STUDIOCRM_FTP_PASSWORD//\\/\\\\}; pw=${pw//\"/\\\"}
printf 'user = "%s:%s"\nssl-reqd\nsilent\nshow-error\nconnect-timeout = 20\nmax-time = 180\nftp-create-dirs\n' "$FTP_USER" "$pw" > "$CURLCFG"
unset pw
# Explicit TLS on port 21, as the server's FEAT advertises. A refused login (curl 67) stops at once:
# retrying a wrong password could get the FTP account locked.
ftp() {
  local rc=0
  curl -K "$CURLCFG" "$@" || rc=$?
  (( rc != 67 )) || fail "the FTP server refused the login for $FTP_USER — check the STUDIOCRM_FTP_PASSWORD secret."
  return $rc
}
put() { ftp -T "$1" "$FTP/$2" || fail "uploading $2 failed — the site still runs the previous build (nothing restarts it until web.config is uploaded)."; }

live_version() { curl -s -m 10 "$HEALTH_URL" | jq -r '.data.version // empty' 2>/dev/null | tr -d '\r' || true; }

log "deploying $SHORT to $APP_URL"
summary "### StudioCRM deploy \`$SHORT\`"

# 1. Files the running build does not use yet: the new fingerprinted web assets, fonts, the shaper.
#    Old assets stay, so a page already open keeps loading. Nothing restarts during this.
n=0
while IFS= read -r f; do put "$DIST/$f" "$DIST/$f"; n=$((n + 1)); done < <(cd "$DIST" && find public fonts -type f ! -path public/index.html | sort)
put "$DIST/harfbuzz.wasm" "$DIST/harfbuzz.wasm"
log "uploaded $((n + 1)) asset files"

# 2. The new server and the page that points at the new assets.
put "$DIST/server.js" "$DIST/server.js"
put "$DIST/public/index.html" "$DIST/public/index.html"
log "uploaded server.js and index.html"

# 3. web.config last: writing it makes IIS restart Node, which loads the new server.js.
put deploy/web.config web.config
log "uploaded web.config — IIS restarts the app"

# 4. Wait for the new build to answer (normally well under a minute). If IIS has not restarted
#    after 90 s, touch web.config once more.
deadline=$(( $(date +%s) + 300 )); again=$(( $(date +%s) + 90 )); last=''
until [[ $(live_version) == "$SHORT" ]]; do
  (( $(date +%s) < deadline )) || fail "the site did not start answering as $SHORT within 5 minutes (it reports: $(live_version || true)). Read logs/node.log in the site root over FTPS."
  if (( $(date +%s) > again )); then log "still the old build — uploading web.config again"; put deploy/web.config web.config; again=$(( $(date +%s) + 600 )); fi
  v=$(live_version); [[ $v != "$last" ]] && { log "live build is ${v:-not answering yet} ..."; last=$v; }
  sleep 5
done
log "live build is $SHORT"

# 5. Verify, as Deploy-StudioCRM.ps1 -VerifyOnly.
db=$(curl -s -m 20 "$HEALTH_URL" | jq -r '.data.db // empty' | tr -d '\r')
[[ $db == up ]] || echo "::warning::health reports db=${db:-missing} — DATABASE_URL in the site-root .env is missing or wrong."
spa=$(curl -s -o /dev/null -m 20 -w '%{content_type}' "$APP_URL/modules/billing/new")
[[ $spa == text/html* ]] || fail "a refresh on /modules/billing/new returned '$spa' instead of the app shell."
api=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{content_type}' "$APP_URL/api/no-such-route")
[[ $api == "404 application/json"* ]] || fail "an unknown /api path answered '$api' — it must be a JSON 404."
log "verified: health up, SPA deep link, JSON 404"
summary "Live at $APP_URL — build \`$SHORT\`, db \`$db\`."
