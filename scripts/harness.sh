#!/usr/bin/env bash
# Unattended end-to-end harness: a browser the harness owns, the real extension, the real
# native host, a local fixture page, and cassette-replayed model calls. No human click,
# no OpenRouter, no public internet, and nothing of the user's Chrome.
#
#   pnpm harness                      # or: bash scripts/harness.sh
#   bash scripts/harness.sh [--skip-build] [--keep] [--headed] [--seed N] [--no-negative]
#                           [--cross-profile] [--run-timeout S] [--live | --live-only | --scripted-only]
#                           [--live-tasks a,b,c] [--live-timeout S]
#
#   --skip-build     reuse .output/chrome-mv3 as it stands
#   --keep           keep the /tmp dir (profiles, wrappers, sockets) for inspection
#   --headed         show the harness's browser windows
#   --seed N         fixture seed (env NB_HARNESS_SEED; default random, printed)
#   --no-negative    skip the mismatch phase
#   --cross-profile  also replay in a FRESH profile (proves cassettes replay across profiles)
#   --run-timeout S  per-run cap on nb-run (env NB_HARNESS_RUN_TIMEOUT; default 180)
#   --live           run the live tier after the scripted tier (real Doppler key, real
#                    Nemotron pair on OpenRouter, real ebay.com plus local fixtures)
#   --live-only      run only the live tier
#   --scripted-only  run only the scripted tier (the default)
#   --live-tasks csv comma-separated live tasks (env NB_HARNESS_LIVE_TASKS; default all 9:
#                    ebay,userscript_debug,inventory,download,escalation,readonly,login,redaction,stall)
#   --live-timeout S per-run cap on live nb-run (env NB_HARNESS_LIVE_TIMEOUT; default 600)
#
# What one invocation does:
#
#   1. pnpm build -> .output/chrome-mv3 (unless --skip-build).
#   2. Starts a local HTTP fixture (scripts/harness/fixture-server.mjs). Its three
#      inventory rows come from the seed and only reach the DOM after a click on
#      "Reveal inventory"; the expected answer is written to expected.json.
#   3. For each phase, a new isolated browser process:
#        - agent-browser launches its own Chrome for Testing (~/.agent-browser/browsers,
#          through a wrapper passed as the executable path) with a temp --user-data-dir
#          (--profile <tmpdir>) and the unpacked extension (--extension ->
#          --load-extension/--disable-extensions-except), so the extension is loaded at
#          process start and there is no Allow or Load-unpacked click.
#        - That wrapper sets XDG_CONFIG_HOME to a temp dir. The native-messaging manifest
#          com.nanobrowser.host.json is written into <profile>/NativeMessagingHosts (where
#          Chrome on Linux looks when --user-data-dir is set) and into the temp XDG dirs,
#          allowed_origins chrome-extension://dnicmmdhogcepeiooangkhhmdgphmonb/ (the id
#          pinned by the key in wxt.config.ts). ~/.config/google-chrome and
#          ~/.config/chromium are never read or written, and port 9222 is never used:
#          the browser's CDP endpoint is its own --remote-debugging-port=0.
#        - The manifest points at a wrapper in the temp dir that runs THIS repo's
#          host/src/main.ts with NB_HOME, NANOBROWSER_SOCK and the cassette dir all inside
#          the run's own directories, a `doppler` shim first on PATH (the real Doppler is
#          never called), and `node --import scripts/harness/scripted-upstream.mjs`.
#      Phases:
#        record    cassette mode `record`, fresh profile. Model calls are answered by the
#                  scripted Leader/Follower in scripted-upstream.mjs (a policy that reads
#                  what the extension sent it, not a transcript) and recorded by the
#                  host's own cassette code.
#        replay    a new browser + host on a COPY of the record profile, cassette mode
#                  `replay`, network sealed (every fetch throws). Must pass the same
#                  verdict with every model call served from a cassette and reproduce the
#                  record run's tool-call sequence. The copy keeps this the same-profile
#                  case; bundled userscript ids are pinned (src/userscripts/catalog.ts),
#                  so the cross-profile phase below proves a fresh profile matches too.
#        mismatch  (negative control; --no-negative skips it) replay on the same profile
#                  copy against a fixture with a different seed. The cassettes no longer
#                  match the page, so this run MUST fail the verdict.
#        cross-profile  (only with --cross-profile) replay in a fresh profile, expected to
#                  pass. This is the "record once, replay anywhere" proof: every model
#                  call must hit a cassette recorded in the record profile.
#   4. Per phase it asserts, and the harness exits non-zero if any fails:
#        - the browser process is agent-browser's Chrome for Testing binary with the temp
#          --user-data-dir and --load-extension, and its crashpad database is under the
#          temp XDG_CONFIG_HOME
#        - the extension's service worker is running (CDP to the harness's own browser:
#          Target.getTargets, then Runtime.evaluate chrome.runtime.id inside the worker)
#        - the native host was spawned by that browser, is this repo's host/src/main.ts,
#          and reports extensionConnected
#        - nb-run over the host socket (inputFidelity=in-page, observe=dom) completes, and
#          the stream it prints equals the run log the host persisted, event for event
#        - scripts/harness/verdict.mjs over that persisted run JSONL: run.started first;
#          run.ended and the host's run.end both `done`; a Leader->Follower handoff and a
#          Follower->Leader replan; an ok Follower click and an ok Follower extract_text
#          whose result names a fixture SKU; an ok leader_snapshot; a Follower `done`
#          whose summary is exactly
#          {"inventory":[{"sku":"AA-0000","name":"...","stock":N} x3],"count":3}, equal
#          to expected.json in page order; the fixture saw GET / and the click handler's
#          GET /api/inventory; ext.log has no error lines
#        - the page shows the 3 revealed rows afterwards (agent-browser eval)
#        - replay phases: no model call reached the network, and
#          scripts/harness/cassette-diff.mjs finds a cassette for every request (on a miss
#          it prints the first differing message path, record vs replay)
#   5. Verdict self-test: a run log that passes untampered is tampered 10 ways (wrong
#      stock, wrong SKU, [], {}, prose, reordered rows, handoffs removed, status error,
#      click failed, page read removed); every tampered copy must FAIL the verdict.
#   6. The user's own host socket ($XDG_RUNTIME_DIR/nanobrowser.sock) is unchanged.
#
# Everything lands in runs/harness-<UTC stamp>/: harness.log, and per phase run.jsonl
# (stream), runlog.jsonl (persisted), verdict.txt, host.log, ext.log, upstream.jsonl,
# requests.jsonl, chrome-cmdline.txt, service-worker.json, page-after.txt; plus
# cassettes/ and the fixture dirs. Profiles and sockets live in a /tmp dir removed on
# exit unless --keep.
#
# Live tier (--live): the same owned browser and the real extension/host, but the real
# Doppler key and the free OpenRouter pair (nvidia/nemotron-3-ultra-550b-a55b:free
# leader, nvidia/nemotron-3.5-lightning:free follower) -- no scripted fetch, no
# cassette, no doppler shim. Nine tasks (scripts/harness/live-tasks.mjs): the eBay
# scrape on ebay.com with ebay-search-extract, the userscript write-run-revise loop,
# and inventory/download/escalation/read-only/login/redaction/stall on a local
# fixture (scripts/harness/live-fixture-server.mjs). Each task is scored by
# scripts/harness/live-verdict.mjs against ground truth, the side panel is inspected
# per task (scripts/harness/ui-inspect.mjs, screenshot stored per task), and
# scripts/harness/scorecard.mjs prints one line per task plus a total, exiting 0 only
# on a full pass. If GET /key is not ready the tier fails closed with `live blocked`
# before any task runs. `NB_E2E_*` (scripts/e2e.sh overrides) are never read here.
#
# Needs: node (>= 22, host runs .ts directly), jq, agent-browser with its Chrome for Testing
# (`agent-browser install`). Exit 0 = every phase behaved as asserted; 1 = anything else;
# 2 = bad usage or missing prerequisite.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXT_ID=dnicmmdhogcepeiooangkhhmdgphmonb
EXT_DIR="$ROOT/.output/chrome-mv3"
HOST_NAME=com.nanobrowser.host
HARNESS="$ROOT/scripts/harness"

SKIP_BUILD=0
HEADED=0
KEEP=0
NEGATIVE=1
CROSS_PROFILE=0
SEED="${NB_HARNESS_SEED:-$(( (RANDOM << 15 | RANDOM) % 1000000 + 1 ))}"
RUN_TIMEOUT="${NB_HARNESS_RUN_TIMEOUT:-180}"
LIVE=0
LIVE_ONLY=0
SCRIPTED_ONLY=0
LIVE_TASKS="${NB_HARNESS_LIVE_TASKS:-ebay,userscript_debug,inventory,download,escalation,readonly,login,redaction,stall}"
LIVE_TIMEOUT="${NB_HARNESS_LIVE_TIMEOUT:-600}"
LIVE_LEADER="${NB_HARNESS_LIVE_LEADER:-nvidia/nemotron-3-ultra-550b-a55b:free}"
LIVE_FOLLOWER="${NB_HARNESS_LIVE_FOLLOWER:-nvidia/nemotron-3.5-lightning:free}"

usage() { awk 'NR == 1 { next } /^[^#]/ { exit } { print }' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --headed) HEADED=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-negative) NEGATIVE=0; shift ;;
    --cross-profile) CROSS_PROFILE=1; shift ;;
    --seed) SEED="$2"; shift 2 ;;
    --run-timeout) RUN_TIMEOUT="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --live-only) LIVE=1; LIVE_ONLY=1; shift ;;
    --scripted-only) SCRIPTED_ONLY=1; shift ;;
    --live-tasks) LIVE_TASKS="$2"; shift 2 ;;
    --live-timeout) LIVE_TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "harness: unknown option $1" >&2; exit 2 ;;
  esac
done

[ "$LIVE" = "1" ] && [ "$SCRIPTED_ONLY" = "1" ] && { echo "harness: --live/--live-only and --scripted-only contradict" >&2; exit 2; }

for bin in node jq agent-browser timeout; do
  command -v "$bin" >/dev/null || { echo "harness: $bin is required" >&2; exit 2; }
done
NODE_BIN="$(mise which node 2>/dev/null || command -v node)"
# agent-browser's own Chrome for Testing download, never a system or branded Chrome.
CFT_BIN="$(ls -d "$HOME"/.agent-browser/browsers/chrome-*/chrome 2>/dev/null | sort -V | tail -n1)"
[ -x "$CFT_BIN" ] || { echo "harness: no Chrome for Testing under ~/.agent-browser/browsers; run: agent-browser install" >&2; exit 2; }

# Nothing inherited may point agent-browser at another browser or profile.
unset AGENT_BROWSER_CDP AGENT_BROWSER_AUTO_CONNECT AGENT_BROWSER_PROFILE AGENT_BROWSER_EXTENSIONS \
      AGENT_BROWSER_EXECUTABLE_PATH AGENT_BROWSER_ARGS AGENT_BROWSER_SESSION AGENT_BROWSER_RESTORE \
      AGENT_BROWSER_STATE AGENT_BROWSER_HEADED AGENT_BROWSER_PROVIDER

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$ROOT/runs/harness-$STAMP"
mkdir -p "$WORK/cassettes"
# Short path: unix socket paths are capped at 108 bytes.
TMP="$(mktemp -d /tmp/nb-harness.XXXXXX)"
exec > >(tee -a "$WORK/harness.log") 2>&1

SESSIONS=()
FIXTURE_PIDS=()
FAILURES=()
cleanup() {
  local s
  for s in "${SESSIONS[@]}"; do agent-browser --session "$s" close >/dev/null 2>&1 || true; done
  local p
  for p in "${FIXTURE_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ "$KEEP" = "1" ]; then echo "kept temp dir: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILURES+=("$CURRENT_PHASE: $*"); }
CURRENT_PHASE=setup

echo "harness run:  $WORK"
echo "temp dir:     $TMP"
echo "seed:         $SEED"
echo "node:         $NODE_BIN ($("$NODE_BIN" --version))"
echo "agent-browser $(agent-browser --version 2>/dev/null | awk '{print $2}'), browser: $CFT_BIN"

# The user's own host socket, if any. The harness must leave it exactly as it found it.
REAL_SOCK="${XDG_RUNTIME_DIR:-$HOME/.local/share/nanobrowser/run}/nanobrowser.sock"
real_sock_id() { stat -c '%i %Y' "$REAL_SOCK" 2>/dev/null || echo absent; }
REAL_SOCK_BEFORE="$(real_sock_id)"

# ------------------------------------------------------------------------- 1. build
if [ "$SKIP_BUILD" = "1" ]; then
  step "build (skipped)"
  [ -f "$EXT_DIR/manifest.json" ] || { echo "harness: --skip-build but $EXT_DIR/manifest.json is missing" >&2; exit 2; }
else
  step "build"
  pnpm build >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log"; echo "harness: pnpm build failed" >&2; exit 1; }
  echo "built $EXT_DIR"
fi
MANIFEST_KEY_ID="$(jq -r '.key' "$EXT_DIR/manifest.json" | base64 -d | sha256sum | head -c 32 | tr '0-9a-f' 'a-p')"
[ "$MANIFEST_KEY_ID" = "$EXT_ID" ] || { echo "harness: built manifest key gives id $MANIFEST_KEY_ID, expected $EXT_ID" >&2; exit 1; }
echo "manifest key -> extension id $MANIFEST_KEY_ID"

# ---------------------------------------------------------------------- 2. fixtures
start_fixture() { # <name> <seed>
  local dir="$WORK/fixture-$1"
  node "$HARNESS/fixture-server.mjs" --seed "$2" --out "$dir" >"$dir.log" 2>&1 &
  FIXTURE_PIDS+=($!)
  local i
  for i in $(seq 1 50); do [ -f "$dir/ready.json" ] && break; sleep 0.1; done
  [ -f "$dir/ready.json" ] || { cat "$dir.log"; echo "harness: fixture $1 did not start" >&2; exit 1; }
}
step "fixture pages"
if [ "$LIVE_ONLY" = "0" ]; then
start_fixture main "$SEED"
FIXTURE_URL="$(jq -r .url "$WORK/fixture-main/ready.json")"
echo "main fixture:     $FIXTURE_URL  expected rows: $(jq -c . "$WORK/fixture-main/expected.json")"
if [ "$NEGATIVE" = "1" ]; then
  start_fixture mismatch "$((SEED + 1))"
  MISMATCH_URL="$(jq -r .url "$WORK/fixture-mismatch/ready.json")"
  echo "mismatch fixture: $MISMATCH_URL  rows: $(jq -c . "$WORK/fixture-mismatch/expected.json")"
fi
else
echo "(scripted fixtures skipped: --live-only)"
fi

# The host's SecretStore shells out to `doppler`. This shim answers instead, so the real
# Doppler (and the user's real key) is never touched; the fake key only ever reaches the
# scripted fetch in record mode and is never used at all in replay.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/doppler" <<'SHIM'
#!/bin/sh
case "$*" in
  *OPENROUTER_API_KEY*) echo "nb-harness-not-a-real-key" ;;
  *) exit 1 ;;
esac
SHIM
chmod 0755 "$TMP/bin/doppler"

PROMPT='Reveal the inventory on this page and report every item. Call done with a summary that is only a JSON object {"inventory":[{"sku":"<sku>","name":"<name>","stock":<number>}],"count":<number of items>}, rows in page order, and no other text.'

# ------------------------------------------------------------------------ 3. phases
run_phase() { # <name> <cassette mode> <fixture url> <fixture dir> <expect: pass|fail> [<profile to copy>]
  local name="$1" mode="$2" url="$3" fixdir="$4" expect="$5" profile_from="${6:-}"
  CURRENT_PHASE="$name"
  local D="$TMP/$name" OUT="$WORK/$name"
  mkdir -p "$D" "$OUT"
  if [ -n "$profile_from" ]; then
    cp -a "$profile_from" "$D/profile"
    rm -f "$D/profile"/Singleton*
  fi
  mkdir -p "$D/profile/NativeMessagingHosts" "$D/home"
  local xdgdir
  for xdgdir in chromium google-chrome google-chrome-for-testing; do mkdir -p "$D/xdg/$xdgdir/NativeMessagingHosts"; done

  step "phase $name: cassette=$mode fixture=$url profile=$([ -n "$profile_from" ] && echo "copy of $profile_from" || echo fresh) (expect verdict $expect)"

  cat >"$D/nanobrowser-host" <<WRAP
#!/bin/sh
# Written by scripts/harness.sh for one phase. Spawned by the harness's own browser only.
NANOBROWSER_DEV=1
NANOBROWSER_CASSETTE=$mode
NANOBROWSER_CASSETTE_DIR=$WORK/cassettes
NANOBROWSER_SOCK=$D/nb.sock
NB_HOME=$D/home
NB_HARNESS_UPSTREAM_LOG=$OUT/upstream.jsonl
NB_HARNESS_REQUEST_LOG=$OUT/requests.jsonl
PATH=$TMP/bin:\$PATH
export NANOBROWSER_DEV NANOBROWSER_CASSETTE NANOBROWSER_CASSETTE_DIR NANOBROWSER_SOCK NB_HOME NB_HARNESS_UPSTREAM_LOG NB_HARNESS_REQUEST_LOG PATH
exec "$NODE_BIN" --import "$HARNESS/scripted-upstream.mjs" "$ROOT/host/src/main.ts" "\$@"
WRAP
  chmod 0755 "$D/nanobrowser-host"
  local manifest
  manifest="$(jq -n --arg path "$D/nanobrowser-host" --arg origin "chrome-extension://$EXT_ID/" \
    '{name: "com.nanobrowser.host", description: "nanobrowser harness host", path: $path, type: "stdio", allowed_origins: [$origin]}')"
  local mdir
  for mdir in "$D/profile/NativeMessagingHosts" "$D"/xdg/*/NativeMessagingHosts; do
    printf '%s\n' "$manifest" >"$mdir/$HOST_NAME.json"
  done

  # agent-browser's daemon does not hand its caller's environment to Chrome, so the
  # isolation env rides on an executable wrapper that execs agent-browser's own binary.
  cat >"$D/chrome" <<CHROME
#!/bin/sh
XDG_CONFIG_HOME=$D/xdg; export XDG_CONFIG_HOME
exec "$CFT_BIN" "\$@"
CHROME
  chmod 0755 "$D/chrome"

  local S
  S="$(agent-browser session id --scope worktree --prefix nbharness 2>/dev/null || echo nbharness)-$name-$$"
  SESSIONS+=("$S")
  # Every agent-browser call carries the same launch config, so none of them relaunches
  # the browser with different options.
  local headed=()
  [ "$HEADED" = "1" ] && headed=(--headed)
  ab() {
    XDG_CONFIG_HOME="$D/xdg" AGENT_BROWSER_PROFILE="$D/profile" AGENT_BROWSER_EXTENSIONS="$EXT_DIR" \
      AGENT_BROWSER_EXECUTABLE_PATH="$D/chrome" \
      agent-browser --session "$S" "${headed[@]}" "$@"
  }

  local hits_before
  hits_before="$(wc -l <"$fixdir/hits.jsonl" 2>/dev/null || echo 0)"

  # --- browser with the extension loaded at process start
  if ! ab open "$url" >"$OUT/agent-browser-open.log" 2>&1; then
    cat "$OUT/agent-browser-open.log"; bad "agent-browser could not launch the isolated browser"; return
  fi
  ok "agent-browser launched session $S on $url"

  # --- isolation: which Chrome is this, really
  local pid cmd
  pid="$(pgrep -f -- "--user-data-dir=$D/profile" | while read -r p; do
           [[ "$(tr '\0' ' ' </proc/"$p"/cmdline 2>/dev/null)" != *"--type="* ]] && echo "$p"; done | head -n1)"
  if [ -z "$pid" ]; then
    bad "no browser process with --user-data-dir=$D/profile"; return
  fi
  cmd="$(tr '\0' ' ' </proc/"$pid"/cmdline)"
  printf '%s\n' "$cmd" >"$OUT/chrome-cmdline.txt"
  local exe
  exe="$(readlink -f /proc/"$pid"/exe)"
  if [[ "$exe" == "$HOME/.agent-browser/browsers/"* && "$cmd" == *"--load-extension=$EXT_DIR"* \
        && "$cmd" == *"--disable-extensions-except=$EXT_DIR"* && "$cmd" != *".config/google-chrome"* ]]; then
    ok "browser pid $pid is $exe with --user-data-dir=$D/profile --load-extension=$EXT_DIR"
  else
    bad "browser pid $pid is not the isolated Chrome for Testing launch: exe=$exe (cmdline in $OUT/chrome-cmdline.txt)"
  fi
  # /proc/<pid>/environ is useless here (Chrome overwrites it when it sets its process
  # title); what Chrome derived from XDG_CONFIG_HOME is visible in its crashpad database.
  local crashpad
  crashpad="$(pgrep -a -f -- "chrome_crashpad_handler.*--database=$D/xdg/" | head -n1)"
  if [ -n "$crashpad" ]; then
    ok "browser config root is the temp XDG_CONFIG_HOME: $(grep -o -- "--database=[^ ]*" <<<"$crashpad" | head -n1)"
  else
    bad "browser did not take its config root from XDG_CONFIG_HOME=$D/xdg (no crashpad database under it)"
  fi

  # --- service worker
  local ws probe
  ws="$(ab get cdp-url 2>/dev/null | grep -Eo 'ws://[^[:space:]]+' | head -n1)"
  if [ -z "$ws" ]; then bad "agent-browser gave no CDP url for its browser"; return; fi
  probe="$(node "$HARNESS/cdp-probe.mjs" --ws "$ws" --id "$EXT_ID" --timeout 30)"
  printf '%s\n' "$probe" >"$OUT/service-worker.json"
  if jq -e '.ok' <<<"$probe" >/dev/null 2>&1; then
    ok "service worker up: $(jq -r '"\(.worker) in \(.browser), chrome.runtime.id=\(.runtime.id) v\(.runtime.version)"' <<<"$probe")"
  else
    bad "service worker probe: $(jq -r '.error // .' <<<"$probe" 2>/dev/null || echo "$probe")"; return
  fi

  # --- native host spawned by this browser
  local status="" i
  for i in $(seq 1 60); do
    if [ -S "$D/nb.sock" ]; then
      status="$(NANOBROWSER_SOCK="$D/nb.sock" host/bin/nb-status 2>/dev/null)"
      jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1 && break
    fi
    sleep 0.5
  done
  printf '%s\n' "$status" >"$OUT/nb-status.json"
  if jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1; then
    local host_pid; host_pid="$(jq -r .pid <<<"$status")"
    local host_cmd; host_cmd="$(tr '\0' ' ' </proc/"$host_pid"/cmdline 2>/dev/null)"
    local host_parent; host_parent="$(ps -o ppid= -p "$host_pid" 2>/dev/null | tr -d ' ')"
    ok "native host pid $host_pid connected (parent pid $host_parent; key: $(jq -c .key <<<"$status"))"
    printf '%s\n' "$host_cmd" >"$OUT/host-cmdline.txt"
    [[ "$host_cmd" == *"$ROOT/host/src/main.ts"* && "$host_cmd" == *"chrome-extension://$EXT_ID/"* ]] \
      && ok "host is this repo's host/src/main.ts, launched for chrome-extension://$EXT_ID/" \
      || bad "host command line is unexpected: $host_cmd"
  else
    bad "native host never reported extensionConnected at $D/nb.sock (last status: ${status:-none})"; return
  fi

  # --- the run
  # A dev run acts on the active tab; make sure it is the fixture, not a new-tab page.
  ab open "$url" >/dev/null 2>&1 || true
  local stream="$OUT/run.jsonl"
  echo "  run: nb-run (timeout ${RUN_TIMEOUT}s) -> $stream"
  NANOBROWSER_SOCK="$D/nb.sock" timeout "$RUN_TIMEOUT" host/bin/nb-run "$PROMPT" \
    --url "$url" \
    --option leaderModel=harness/scripted-leader \
    --option followerModel=harness/scripted-follower \
    --option observe=dom \
    --option inputFidelity=in-page \
    --option planningInterval=5 \
    --option maxSteps=12 \
    >"$stream" 2>"$OUT/nb-run.stderr"
  local rc=$?
  echo "  nb-run exit $rc, $(wc -l <"$stream") events, $(tr '\n' ' ' <"$OUT/nb-run.stderr")"

  # The product's own run log, persisted by the host. The verdict judges this file; the
  # nb-run stream must carry exactly the same events in the same order.
  local run_id runlog="$OUT/runlog.jsonl"
  run_id="$(grep -o 'runId=[A-Za-z0-9_-]*' "$OUT/nb-run.stderr" | head -n1 | cut -d= -f2)"
  if [ -n "$run_id" ] && cp "$D/home/.local/share/nanobrowser/runs/$run_id.jsonl" "$runlog" 2>/dev/null; then
    ok "host persisted run log $run_id.jsonl ($(wc -l <"$runlog") events)"
  else
    bad "no persisted run log for runId=${run_id:-<none>}"; : >"$runlog"
  fi
  jq -rc '[.kind // .type, (.from // empty) + (if .to then "->" + .to else "" end), .role // empty, .call.name // .result.name // empty,
           (if .result then "ok=\(.result.ok)" else empty end), .status // empty] | map(select(. != "")) | join(" ")' "$runlog" \
    | sed 's/^/    /'
  if [ -s "$runlog" ] && [ "$(jq -c . "$stream")" = "$(jq -c . "$runlog")" ]; then
    ok "the nb-run stream delivered every run-log event, in order"
  else
    bad "the nb-run stream ($(wc -l <"$stream") events) differs from the persisted run log ($(wc -l <"$runlog") events)"
  fi

  # --- page state after the run, straight from the browser
  local rows_on_page
  rows_on_page="$(ab eval "document.querySelectorAll('#inventory li').length" 2>/dev/null | tr -dc '0-9')"
  ab snapshot >"$OUT/page-after.txt" 2>&1 || true
  tail -n +"$((hits_before + 1))" "$fixdir/hits.jsonl" >"$OUT/fixture-hits.jsonl" 2>/dev/null || true

  cp "$D/home/.local/share/nanobrowser/host.log" "$OUT/host.log" 2>/dev/null || true
  cp "$D/home/.local/share/nanobrowser/ext.log" "$OUT/ext.log" 2>/dev/null || : >"$OUT/ext.log"

  # --- verdict
  echo "  verdict:"
  node "$HARNESS/verdict.mjs" --stream "$runlog" --expected "$fixdir/expected.json" \
    --hits "$OUT/fixture-hits.jsonl" --ext-log "$OUT/ext.log" | tee "$OUT/verdict.txt"
  local verdict=${PIPESTATUS[0]}

  if [ "$expect" = "pass" ]; then
    [ "$verdict" -eq 0 ] && ok "verdict passed" || bad "verdict failed (see $OUT/verdict.txt)"
    [ "$rows_on_page" = "3" ] && ok "the page now shows 3 revealed inventory rows" \
      || bad "the page shows ${rows_on_page:-?} inventory rows after the run, want 3"
  else
    [ "$verdict" -ne 0 ] && ok "verdict failed, as a mismatched page must" \
      || bad "verdict PASSED against a page the cassettes do not match: replay is not keyed to the page"
  fi

  if [ "$mode" = "replay" ]; then
    local leaked
    leaked="$(jq -s '[.[] | select(.sealed == true and (.url | test("chat/completions")))] | length' "$OUT/upstream.jsonl" 2>/dev/null || echo 0)"
    [ "${leaked:-0}" = "0" ] && ok "no model call reached the network (sealed fetch saw 0 chat/completions)" \
      || bad "$leaked model call(s) tried the network in replay mode"
    echo "  cassette lookups (request log vs record phase):"
    node "$HARNESS/cassette-diff.mjs" --record "$WORK/record/requests.jsonl" --replay "$OUT/requests.jsonl" \
      --cassettes "$WORK/cassettes" | tee "$OUT/cassette-diff.txt"
    local diffrc=${PIPESTATUS[0]}
    if [ "$expect" = "pass" ]; then
      [ "$diffrc" -eq 0 ] && ok "every model call was served from a recorded cassette" \
        || bad "replay missed cassettes (see $OUT/cassette-diff.txt)"
    fi
  fi

  ab close >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------ live tier
# Same owned browser and real extension/host as the scripted phases, but the real
# Doppler key and the free OpenRouter pair -- no scripted fetch, no cassette, no
# doppler shim. Fails closed with `live blocked` when GET /key is not ready.
start_live_fixture() {
  local dir="$WORK/fixture-live"
  node "$HARNESS/live-fixture-server.mjs" --seed "$SEED" --out "$dir" >"$WORK/fixture-live.log" 2>&1 &
  FIXTURE_PIDS+=($!)
  local i
  for i in $(seq 1 50); do [ -f "$dir/ready.json" ] && break; sleep 0.1; done
  [ -f "$dir/ready.json" ] || { cat "$WORK/fixture-live.log"; echo "harness: live fixture did not start" >&2; exit 1; }
}

run_live() {
  CURRENT_PHASE=live
  local OUT="$WORK/live" D="$TMP/live"
  mkdir -p "$D/profile/NativeMessagingHosts" "$D/home/Downloads" "$OUT/results"
  local xdgdir
  for xdgdir in chromium google-chrome google-chrome-for-testing; do mkdir -p "$D/xdg/$xdgdir/NativeMessagingHosts"; done

  step "live self-test (no key needed)"
  if node "$HARNESS/live-selftest.mjs" >"$OUT/selftest.txt" 2>&1; then
    ok "live verdicts accept good synthetic logs and reject tampers ($(grep -c '^  PASS' "$OUT/selftest.txt") checks)"
  else
    cat "$OUT/selftest.txt"; bad "live verdict self-test failed (see $OUT/selftest.txt)"
    # Fail closed: untrusted scorers must not spend the real key and network on
    # tasks whose verdicts would be meaningless. The recorded failure still fails
    # the harness; the summary below reports the tier as unfinished.
    return
  fi

  step "live fixture"
  start_live_fixture
  local LIVE_BASE
  LIVE_BASE="$(jq -r .baseUrl "$WORK/fixture-live/ready.json")"
  echo "live fixture: $LIVE_BASE (seed $SEED)"
  echo "live models:  leader=$LIVE_LEADER follower=$LIVE_FOLLOWER (OpenRouter https://openrouter.ai/api/v1/)"

  local known task
  known="$(node "$HARNESS/live-tasks.mjs" --list | tr '\n' ' ')"
  # An empty task list would run zero tasks and score 0/0 as a pass; refuse it here.
  [ -n "${LIVE_TASKS//[ ,]/}" ] || { echo "harness: --live-tasks names no task; refusing a 0-task live tier" >&2; exit 2; }
  for task in ${LIVE_TASKS//,/ }; do
    [[ " $known " == *" $task "* ]] || { echo "harness: unknown live task $task (known: $known)" >&2; exit 2; }
  done

  step "live browser + host (real Doppler key, real network)"
  local doppler_dir=""
  if command -v doppler >/dev/null 2>&1; then doppler_dir="$(dirname "$(command -v doppler)"):"; fi
  cat >"$D/nanobrowser-host" <<WRAP
#!/bin/sh
# Written by scripts/harness.sh for the live tier. Spawned by the harness's own browser only.
NANOBROWSER_DEV=1
NANOBROWSER_SOCK=$D/nb.sock
NB_HOME=$D/home
PATH=${doppler_dir}\$PATH
export NANOBROWSER_DEV NANOBROWSER_SOCK NB_HOME PATH
exec "$NODE_BIN" "$ROOT/host/src/main.ts" "\$@"
WRAP
  chmod 0755 "$D/nanobrowser-host"
  local manifest
  manifest="$(jq -n --arg path "$D/nanobrowser-host" --arg origin "chrome-extension://$EXT_ID/" \
    '{name: "com.nanobrowser.host", description: "nanobrowser harness host (live)", path: $path, type: "stdio", allowed_origins: [$origin]}')"
  local mdir
  for mdir in "$D/profile/NativeMessagingHosts" "$D"/xdg/*/NativeMessagingHosts; do
    printf '%s\n' "$manifest" >"$mdir/$HOST_NAME.json"
  done

  # The browser's default download dir (~/Downloads) is contained via xdg-user-dirs,
  # not via HOME: the live host below must see the real HOME (Doppler reads its token
  # from ~/.doppler), and Chrome resolves the download dir from $XDG_CONFIG_HOME's
  # user-dirs.dirs, which already points at the temp dir. agent-browser itself keeps
  # the real environment (its Chrome for Testing lives under the real HOME).
  printf 'XDG_DOWNLOAD_DIR="%s"\n' "$D/home/Downloads" >"$D/xdg/user-dirs.dirs"
  cat >"$D/chrome" <<CHROME
#!/bin/sh
XDG_CONFIG_HOME=$D/xdg; export XDG_CONFIG_HOME
exec "$CFT_BIN" "\$@"
CHROME
  chmod 0755 "$D/chrome"

  local S
  S="$(agent-browser session id --scope worktree --prefix nbharness 2>/dev/null || echo nbharness)-live-$$"
  SESSIONS+=("$S")
  local headed=()
  [ "$HEADED" = "1" ] && headed=(--headed)
  ab_live() {
    XDG_CONFIG_HOME="$D/xdg" AGENT_BROWSER_PROFILE="$D/profile" AGENT_BROWSER_EXTENSIONS="$EXT_DIR" \
      AGENT_BROWSER_EXECUTABLE_PATH="$D/chrome" \
      agent-browser --session "$S" "${headed[@]}" "$@"
  }

  if ! ab_live open "$LIVE_BASE/" >"$OUT/agent-browser-open.log" 2>&1; then
    cat "$OUT/agent-browser-open.log"; bad "agent-browser could not launch the live browser"; return
  fi
  ok "agent-browser launched live session $S on $LIVE_BASE/"

  local pid cmd
  pid="$(pgrep -f -- "--user-data-dir=$D/profile" | while read -r p; do
           [[ "$(tr '\0' ' ' </proc/"$p"/cmdline 2>/dev/null)" != *"--type="* ]] && echo "$p"; done | head -n1)"
  if [ -z "$pid" ]; then bad "no live browser process with --user-data-dir=$D/profile"; return; fi
  cmd="$(tr '\0' ' ' </proc/"$pid"/cmdline)"
  printf '%s\n' "$cmd" >"$OUT/chrome-cmdline.txt"
  local exe
  exe="$(readlink -f /proc/"$pid"/exe)"
  if [[ "$exe" == "$HOME/.agent-browser/browsers/"* && "$cmd" == *"--load-extension=$EXT_DIR"* \
        && "$cmd" == *"--disable-extensions-except=$EXT_DIR"* && "$cmd" != *".config/google-chrome"* ]]; then
    ok "live browser pid $pid is $exe with --user-data-dir=$D/profile --load-extension=$EXT_DIR"
  else
    bad "live browser pid $pid is not the isolated Chrome for Testing launch: exe=$exe"
  fi
  local crashpad
  crashpad="$(pgrep -a -f -- "chrome_crashpad_handler.*--database=$D/xdg/" | head -n1)"
  if [ -n "$crashpad" ]; then
    ok "live browser config root is the temp XDG_CONFIG_HOME"
  else
    bad "live browser did not take its config root from XDG_CONFIG_HOME=$D/xdg"
  fi

  local ws probe
  ws="$(ab_live get cdp-url 2>/dev/null | grep -Eo 'ws://[^[:space:]]+' | head -n1)"
  if [ -z "$ws" ]; then bad "agent-browser gave no CDP url for its live browser"; return; fi
  probe="$(node "$HARNESS/cdp-probe.mjs" --ws "$ws" --id "$EXT_ID" --timeout 30)"
  printf '%s\n' "$probe" >"$OUT/service-worker.json"
  if jq -e '.ok' <<<"$probe" >/dev/null 2>&1; then
    ok "live service worker up: $(jq -r '"\(.worker) in \(.browser)"' <<<"$probe")"
  else
    bad "live service worker probe: $(jq -r '.error // .' <<<"$probe" 2>/dev/null || echo "$probe")"; return
  fi

  local status="" i
  for i in $(seq 1 60); do
    if [ -S "$D/nb.sock" ]; then
      status="$(NANOBROWSER_SOCK="$D/nb.sock" host/bin/nb-status 2>/dev/null)"
      jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1 && break
    fi
    sleep 0.5
  done
  printf '%s\n' "$status" >"$OUT/nb-status.json"
  if ! jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1; then
    bad "live native host never reported extensionConnected at $D/nb.sock"; return
  fi
  ok "live native host connected (pid $(jq -r .pid <<<"$status"))"

  # Fail closed: no key, no tasks, no pass. The scorecard prints `live blocked`.
  local key_ready key_reason
  key_ready="$(jq -r .key.ready "$OUT/nb-status.json")"
  key_reason="$(jq -r '.key.reason // "GET /key is not ready"' "$OUT/nb-status.json")"
  if [ "$key_ready" != "true" ]; then
    echo "live blocked: $key_reason"
    jq -n --arg reason "$key_reason" --arg leader "$LIVE_LEADER" --arg follower "$LIVE_FOLLOWER" \
      '{blocked: true, reason: $reason, models: {leader: $leader, follower: $follower}}' >"$OUT/scorecard.json"
    printf 'live      blocked (%s)\n' "$key_reason" | tee "$OUT/scorecard.txt"
    FAILURES+=("live: blocked ($key_reason)")
    ab_live close >/dev/null 2>&1 || true
    return
  fi
  ok "live key is ready (GET /key validated)"

  # The panel must be open DURING runs: it only shows live broadcasts, so opening
  # it after a run would show an empty log.
  local panel_target=""
  panel_target="$(node "$HARNESS/ui-inspect.mjs" --mode open --ws "$ws" --id "$EXT_ID" --timeout 30 \
    | tee "$OUT/panel-open.json" | jq -r '.targetId // empty' 2>/dev/null)"
  if [ -n "$panel_target" ]; then
    ok "side panel open in the harness browser (target $panel_target)"
  else
    bad "side panel did not reach connected in the harness browser (see $OUT/panel-open.json); verdicts only"
  fi

  local hits_total host_lines ext_lines
  : >"$OUT/results.jsonl"
  for task in ${LIVE_TASKS//,/ }; do
    CURRENT_PHASE="live:$task"
    local TJSON="$OUT/$task-task.json"
    node "$HARNESS/live-tasks.mjs" --task "$task" --expected "$WORK/fixture-live/expected.json" --base-url "$LIVE_BASE" \
      --leader "$LIVE_LEADER" --follower "$LIVE_FOLLOWER" >"$TJSON"
    local url prompt
    url="$(jq -r .url "$TJSON")"
    prompt="$(jq -r .prompt "$TJSON")"
    step "live task $task: $(jq -r .title "$TJSON")"
    echo "  url: $url"

    hits_total="$(wc -l <"$WORK/fixture-live/hits.jsonl" 2>/dev/null || echo 0)"
    host_lines="$(wc -l <"$D/home/.local/share/nanobrowser/host.log" 2>/dev/null || echo 0)"
    ext_lines="$(wc -l <"$D/home/.local/share/nanobrowser/ext.log" 2>/dev/null || echo 0)"

    # read-only needs stored readOnly on: nb-run --option values are strings and the
    # worker only honours a boolean readOnly, so the option cannot carry it. The Setup
    # toggle is the real path, and the plan expects it on for this task anyway.
    if [ "$task" = "readonly" ] && [ -n "$panel_target" ]; then
      if node "$HARNESS/ui-inspect.mjs" --mode toggle --ws "$ws" --target "$panel_target" \
           --toggle read-only --on true >"$OUT/$task-toggle-on.json" 2>&1; then
        ok "read-only toggle on for the readonly task"
      else
        bad "could not flip the read-only toggle on (see $OUT/$task-toggle-on.json)"
      fi
    fi

    ab_live open "$url" >/dev/null 2>&1 || true
    # The panel target stole focus when it was created; the worker refuses to run on
    # an extension page, so the task tab must be frontmost before nb-run.
    if node "$HARNESS/ui-inspect.mjs" --mode activate --ws "$ws" --match "${url%%\?*}" >"$OUT/$task-activate.json" 2>&1; then
      ok "task tab is frontmost ($(jq -r .url "$OUT/$task-activate.json" | cut -c1-80))"
    else
      bad "could not activate the task tab for $task (see $OUT/$task-activate.json)"
    fi
    local stream="$OUT/$task-run.jsonl"
    local opt_args=()
    while IFS= read -r kv; do opt_args+=(--option "$kv"); done \
      < <(jq -r '.options | to_entries[] | select(.key != "readOnly") | "\(.key)=\(.value)"' "$TJSON")
    echo "  run: nb-run (timeout ${LIVE_TIMEOUT}s) -> $stream"
    NANOBROWSER_SOCK="$D/nb.sock" timeout "$LIVE_TIMEOUT" host/bin/nb-run "$prompt" \
      --url "$url" "${opt_args[@]}" >"$stream" 2>"$OUT/$task-nb-run.stderr"
    local rc=$?
    echo "  nb-run exit $rc, $(wc -l <"$stream") events"

    local run_id runlog="$OUT/$task-runlog.jsonl"
    run_id="$(grep -o 'runId=[A-Za-z0-9_-]*' "$OUT/$task-nb-run.stderr" | head -n1 | cut -d= -f2)"
    if [ "$rc" -eq 124 ] && [ -n "$run_id" ]; then
      echo "  nb-run timed out; cancelling $run_id so the next task starts clean"
      NANOBROWSER_SOCK="$D/nb.sock" host/bin/nb-cancel "$run_id" >/dev/null 2>&1 || true
    fi
    if [ -n "$run_id" ] && cp "$D/home/.local/share/nanobrowser/runs/$run_id.jsonl" "$runlog" 2>/dev/null; then
      ok "host persisted run log $run_id.jsonl ($(wc -l <"$runlog") events)"
    else
      bad "no persisted run log for runId=${run_id:-<none>}"; : >"$runlog"
    fi

    # NOTE: the read-only toggle stays on through the verdict and UI inspection
    # below (the inspection requires it on); it is reset after aggregation.

    tail -n +"$((hits_total + 1))" "$WORK/fixture-live/hits.jsonl" >"$OUT/$task-hits.jsonl" 2>/dev/null || true
    tail -n +"$((host_lines + 1))" "$D/home/.local/share/nanobrowser/host.log" >"$OUT/$task-host.log" 2>/dev/null || : >"$OUT/$task-host.log"
    tail -n +"$((ext_lines + 1))" "$D/home/.local/share/nanobrowser/ext.log" >"$OUT/$task-ext.log" 2>/dev/null || : >"$OUT/$task-ext.log"

    # eBay ground truth, scraped independently from the results DOM (not the userscript).
    local page_arg=()
    if [ "$task" = "ebay" ]; then
      ab_live eval "$(cat "$HARNESS/ebay-extract.js")" >"$OUT/ebay-page.raw" 2>&1 || true
      if jq -e 'type == "array"' "$OUT/ebay-page.raw" >/dev/null 2>&1; then
        cp "$OUT/ebay-page.raw" "$OUT/ebay-page.json"
      elif jq -r . "$OUT/ebay-page.raw" 2>/dev/null | jq -e 'type == "array"' >/dev/null 2>&1; then
        jq -r . "$OUT/ebay-page.raw" >"$OUT/ebay-page.json"
      else
        grep -o '\[.*\]' "$OUT/ebay-page.raw" | head -n1 >"$OUT/ebay-page.json" 2>/dev/null || echo '[]' >"$OUT/ebay-page.json"
      fi
      echo "  page listings scraped independently: $(jq 'length' "$OUT/ebay-page.json" 2>/dev/null || echo '?')"
      page_arg=(--page "$OUT/ebay-page.json")
    fi

    echo "  verdict:"
    node "$HARNESS/live-verdict.mjs" --task "$task" --stream "$runlog" \
      --expected "$WORK/fixture-live/expected.json" "${page_arg[@]}" \
      --host-log "$OUT/$task-host.log" --ext-log "$OUT/$task-ext.log" \
      --download-dirs "$D/home/Downloads:$D/profile" --hits "$OUT/$task-hits.jsonl" \
      --json "$OUT/$task-verdict.json" | tee "$OUT/$task-verdict.txt"
    local verdict_rc=${PIPESTATUS[0]}
    [ "$verdict_rc" -eq 0 ] && ok "verdict passed for $task" || bad "verdict failed for $task (see $OUT/$task-verdict.txt)"

    local inspect_file="$OUT/$task-inspection.json"
    if [ -n "$panel_target" ]; then
      echo "  UI inspection:"
      node "$HARNESS/ui-inspect.mjs" --mode check --ws "$ws" --target "$panel_target" --task "$task" \
        --runlog "$runlog" --expected "$WORK/fixture-live/expected.json" --out "$OUT" --expect-ready true \
        | tee "$OUT/$task-inspection.txt"
      [ "${PIPESTATUS[0]}" -eq 0 ] && ok "UI inspection passed for $task" \
        || bad "UI inspection failed for $task (see $OUT/$task-inspection.txt)"
    fi
    # Missing or empty scorer artifacts fail the task, never pass it: an empty
    # verdict array (or null inspection) would make `all` vacuously true and mark
    # a crashed scorer as passing in the persisted scorecard.
    [ -f "$OUT/$task-verdict.json" ] || echo '[{"name":"verdict crashed before writing results","ok":false,"detail":"see verdict txt"}]' >"$OUT/$task-verdict.json"
    if [ ! -f "$inspect_file" ] && [ -n "$panel_target" ]; then
      jq -n --arg task "$task" '{task: $task, results: [{name: "UI inspection did not run", ok: false, detail: "see inspection txt"}]}' >"$inspect_file"
    fi
    [ -f "$inspect_file" ] || echo 'null' >"$inspect_file"
    # A panel that never opened must fail the task, not vanish into a null
    # inspection the scorecard treats as passing: replace the null with an
    # explicit failed check.
    if [ -z "$panel_target" ]; then
      jq -n --arg task "$task" '{task: $task, results: [{name: "panel opened for UI inspection", ok: false, detail: "openPanel failed; no UI inspection ran"}]}' >"$inspect_file"
    fi
    jq -n --arg task "$task" --arg title "$(jq -r .title "$TJSON")" \
      --slurpfile verdict "$OUT/$task-verdict.json" \
      --slurpfile inspect "$inspect_file" \
      '{task: $task, title: $title,
        passed: ([$verdict[0][] | .ok] | length > 0 and all) and (if $inspect[0] then ([$inspect[0].results[] | .ok] | length > 0 and all) else true end),
        checks: ($verdict[0] + (if $inspect[0] then [$inspect[0].results[] | {name: ("ui: " + .name), ok, detail}] else [] end))}' \
      >>"$OUT/results.jsonl"

    # Reset after aggregation so the next task starts from a full run — and after
    # the inspection above, which requires the toggle still on for this task.
    if [ "$task" = "readonly" ] && [ -n "$panel_target" ]; then
      node "$HARNESS/ui-inspect.mjs" --mode toggle --ws "$ws" --target "$panel_target" \
        --toggle read-only --on false >"$OUT/$task-toggle-off.json" 2>&1 || true
    fi
  done

  CURRENT_PHASE=live
  step "live scorecard"
  jq -s '.' "$OUT/results.jsonl" >"$OUT/results.json"
  node "$HARNESS/scorecard.mjs" --results "$OUT/results.json" --out "$OUT" \
    --leader "$LIVE_LEADER" --follower "$LIVE_FOLLOWER" --seed "$SEED" | tee "$OUT/scorecard.txt"
  [ "${PIPESTATUS[0]}" -eq 0 ] && ok "live scorecard: full pass" \
    || bad "live scorecard: not a full pass (see $OUT/scorecard.txt)"

  ab_live close >/dev/null 2>&1 || true
}

tool_sequence() { jq -sc '[.[] | select(.kind == "tool.call") | [.role, .call.name, .call.args]]' "$1"; }

if [ "$LIVE_ONLY" = "0" ]; then
run_phase record record "$FIXTURE_URL" "$WORK/fixture-main" pass
CURRENT_PHASE=record
CASSETTES="$(find "$WORK/cassettes" -name '*.json' | wc -l)"
[ "$CASSETTES" -gt 0 ] && ok "record phase wrote $CASSETTES cassette(s) to $WORK/cassettes" \
  || bad "record phase wrote no cassettes"

# Replay reuses a copy of the record profile for the same-profile case. Bundled
# userscript ids are pinned (src/userscripts/catalog.ts), so a fresh profile matches
# too — --cross-profile runs that case and expects it to pass.
run_phase replay replay "$FIXTURE_URL" "$WORK/fixture-main" pass "$TMP/record/profile"
CURRENT_PHASE=replay
if [ -s "$WORK/record/runlog.jsonl" ] && [ -s "$WORK/replay/runlog.jsonl" ]; then
  if [ "$(tool_sequence "$WORK/record/runlog.jsonl")" = "$(tool_sequence "$WORK/replay/runlog.jsonl")" ]; then
    ok "replay reproduced the record run's tool-call sequence ($(jq -sc '[.[] | select(.kind=="tool.call") | .call.name]' "$WORK/replay/runlog.jsonl"))"
  else
    bad "replay tool calls differ from record: $(tool_sequence "$WORK/record/runlog.jsonl") vs $(tool_sequence "$WORK/replay/runlog.jsonl")"
  fi
fi

if [ "$NEGATIVE" = "1" ]; then
  run_phase mismatch replay "$MISMATCH_URL" "$WORK/fixture-mismatch" fail "$TMP/record/profile"
fi

if [ "$CROSS_PROFILE" = "1" ]; then
  run_phase cross-profile replay "$FIXTURE_URL" "$WORK/fixture-main" pass
fi

# ------------------------------------------------------------ 5. verdict self-test
CURRENT_PHASE=selftest
step "verdict self-test: a wrong or empty result must fail"
SELFTEST_STREAM=""
for p in replay record; do
  if node "$HARNESS/verdict.mjs" --stream "$WORK/$p/runlog.jsonl" --expected "$WORK/fixture-main/expected.json" >/dev/null 2>&1; then
    SELFTEST_STREAM="$WORK/$p/runlog.jsonl"; break
  fi
done
if [ -n "$SELFTEST_STREAM" ]; then
  ok "untampered $(basename "$(dirname "$SELFTEST_STREAM")") stream passes the verdict; tampering it:"
  for t in wrong-stock wrong-sku empty-array empty-object prose reordered no-handoff status-error click-failed no-page-read; do
    if node "$HARNESS/verdict.mjs" --stream "$SELFTEST_STREAM" --expected "$WORK/fixture-main/expected.json" \
         --tamper "$t" >"$WORK/selftest-$t.txt" 2>&1; then
      bad "tamper $t still passed the verdict"
    else
      ok "tamper $t fails: $(grep -m1 FAIL "$WORK/selftest-$t.txt" | sed 's/^ *FAIL  //' | cut -c1-160)"
    fi
  done
else
  bad "neither the record nor the replay stream passes untampered; nothing meaningful to self-test"
fi
fi # LIVE_ONLY=0 (scripted tier)

if [ "$LIVE" = "1" ]; then
  run_live
fi

# ---------------------------------------------------------------------- summary
CURRENT_PHASE=teardown
REAL_SOCK_AFTER="$(real_sock_id)"
[ "$REAL_SOCK_BEFORE" = "$REAL_SOCK_AFTER" ] && ok "the user's own host socket ($REAL_SOCK) is untouched: $REAL_SOCK_AFTER" \
  || bad "the user's host socket changed: $REAL_SOCK_BEFORE -> $REAL_SOCK_AFTER"

step "result"
echo "logs: $WORK"
if [ -f "$WORK/live/scorecard.txt" ]; then
  echo "--- scorecard ---"
  cat "$WORK/live/scorecard.txt"
elif [ "$LIVE" = "1" ]; then
  echo "live      blocked (tier did not finish; see $WORK/live)"
else
  echo "live      blocked (not requested; run with --live)"
fi
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "HARNESS PASS"
  exit 0
fi
printf '  %s\n' "${FAILURES[@]}"
echo "HARNESS FAIL (${#FAILURES[@]})"
exit 1
