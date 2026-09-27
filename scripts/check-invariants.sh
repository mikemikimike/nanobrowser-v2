#!/usr/bin/env bash
# Stealth invariants (R-02). Each one is a grep, each closes a whole family of
# extension-detection signals. See docs/research/bot-detection-research.md § Recommendation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST=".output/chrome-mv3/manifest.json"
FAILED=0

fail() {
  echo "INVARIANT FAILED: $1"
  FAILED=1
}

pass() {
  echo "ok: $1"
}

if [ ! -f "$MANIFEST" ]; then
  echo "no build found at $MANIFEST — building..."
  pnpm exec wxt build >/dev/null || { echo "build failed"; exit 1; }
fi

# 1. No web_accessible_resources: any listed resource is fetchable by the page and
#    turns the extension into an enumerable, fingerprintable surface.
if grep -q '"web_accessible_resources"' "$MANIFEST"; then
  fail 'manifest declares web_accessible_resources'
else
  pass 'manifest has no web_accessible_resources'
fi

# 2. No externally_connectable: it advertises the extension ID to every allowed origin.
if grep -q '"externally_connectable"' "$MANIFEST"; then
  fail 'manifest declares externally_connectable'
else
  pass 'manifest has no externally_connectable'
fi

# 3. No declared content_scripts: page code is injected on demand with
#    chrome.scripting.executeScript into the ISOLATED world, never standing.
if grep -q '"content_scripts"' "$MANIFEST"; then
  fail 'manifest declares content_scripts'
else
  pass 'manifest has no content_scripts'
fi

# 4. No MAIN-world execution anywhere in source. Userscripts go through
#    chrome.userScripts, a separate API with its own isolation story.
SRC_HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -e 'world: *"MAIN"' -e "world: *'MAIN'" \
  entrypoints src scripts 2>/dev/null || true)"
if [ -n "$SRC_HITS" ]; then
  fail 'source uses world: "MAIN"'
  echo "$SRC_HITS"
else
  pass 'no world: "MAIN" in source'
fi

# 5. No window.postMessage bridge in page-context code. A postMessage channel
#    between the page and the extension is enumerable page-side and turns the
#    extension into a detectable surface; the injected tier talks over
#    chrome.runtime messaging only (see src/page/handler.ts). Word-boundary match
#    so the bare window-scope call is caught alongside window.postMessage.
PAGE_CONTEXT="src/page entrypoints/injected-content.ts src/userscripts"
POST_HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' -e '\<postMessage[[:space:]]*(' $PAGE_CONTEXT 2>/dev/null || true)"
if [ -n "$POST_HITS" ]; then
  fail 'page-context code uses window.postMessage'
  echo "$POST_HITS"
else
  pass 'no postMessage in page-context code'
fi

# 6. No storage writes in page-context code. localStorage/sessionStorage/IndexedDB
#    writes and cookie assignments from injected code are observable page-side
#    (storage events) and persist extension fingerprints past the run. Test files
#    never ship to pages, so they are excluded from this scan.
STORE_HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --exclude='*.test.ts' -e 'localStorage' -e 'sessionStorage' -e 'indexedDB' -e 'document\.cookie[[:space:]]*=' $PAGE_CONTEXT 2>/dev/null || true)"
if [ -n "$STORE_HITS" ]; then
  fail 'page-context code touches web storage'
  echo "$STORE_HITS"
else
  pass 'no web storage in page-context code'
fi

# 7. No fetch in the extension's own injected tier (src/page, injected-content).
#    src/userscripts is exempt: agent/user-authored scripts are governed by the
#    authoring rails (src/userscripts/authoring.ts), and the bundled i03 probe
#    reads its own page over GET by design. Word-boundary match so window.fetch
#    is caught too; prefetch/fetchData and bare mentions without a call are not.
FETCH_HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' -e '\<fetch[[:space:]]*(' src/page entrypoints/injected-content.ts 2>/dev/null || true)"
if [ -n "$FETCH_HITS" ]; then
  fail 'injected tier uses fetch'
  echo "$FETCH_HITS"
else
  pass 'no fetch in the injected tier'
fi

if [ "$FAILED" -ne 0 ]; then
  echo "stealth invariants: FAILED"
  exit 1
fi
echo "stealth invariants: all clear"
