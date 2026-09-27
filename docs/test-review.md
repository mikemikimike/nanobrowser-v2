# Test suite review: what actually proves what

> Note (2026-09-23): `docs/STATUS.md` has since been retired; proof now lives in
> test names and open work in GitHub issues. The STATUS.md rows cited below were
> accurate at audit time and are kept as the historical record.

A rigorous read of every `*.test.ts(x)` under `src/`, `tests/` and `host/test/` against
the module it claims to cover, done in two phases: (1) read every test's actual
assertions (not the `it(...)` string) against the then-current `docs/STATUS.md`'s claims and the six
weakness categories below; (2) for every high/medium finding, add or strengthen a test
in a new `<module>.edge.test.ts` file, and fix the handful of genuine bugs those new
tests exposed in source files outside the concurrently-edited set.

Weakness categories used throughout: **(a)** tautological (asserts the mock/fixture it
just built); **(b)** tests a fake instead of the thin real code path; **(c)** missing
negative/edge case on a security-relevant seam; **(d)** over-broad golden/snapshot;
**(e)** flaky pattern (real timers, unawaited promises, order dependence, shared
mutable state); **(f)** a `docs/STATUS.md` (since retired — see note above) "proving test" that doesn't exist, or exists
but doesn't prove the claim.

Phase 1 was done by five parallel reviewers, each assigned a disjoint slice of the
suite, plus direct verification by the agent writing this document. All findings below
were independently re-derived or spot-checked against the actual source before being
recorded — several "findings" from the initial pass turned out to be already covered,
already fixed by concurrent work elsewhere in the repo, or based on a stale read of a
file another agent had since changed; those are noted as such rather than silently
dropped.

**A note on timing.** This repo had multiple agents editing it concurrently while this
review was written (confirmed by `git diff` and several live file-change
notifications during the session). `src/runtime/modelPolicy.ts` and its
"refuse paid models in the run path" mechanism, for instance, existed at the start of
Phase 1 and was deliberately removed by another agent partway through Phase 2 (see
CLAUDE.md's "Models and money" section — the restriction was intentionally converted
from a runtime check into agent guidance). A drafted test for that mechanism was
dropped rather than shipped against code that no longer exists; this is called out
explicitly rather than left as a silent gap.

## Findings

| File | Finding | Severity | Action taken |
| --- | --- | --- | --- |
| `src/agent/tools.ts` | No test file existed at all. Every zod schema gating a Follower tool call's arguments (bounds on `wait`'s `ms`, the `FollowerSignal` enum, required fields on every tool, `planTool`'s `subgoals.min(1)`) was completely unexercised directly — only indirectly, through `graph.test.ts`'s `FakeChatModel` turns, which always supply well-formed args. This is exactly "does a tool reject bad input from the LLM robustly?", explicitly named in the task brief, and it was unanswered. | high | Added `src/agent/tools.edge.test.ts` (26 tests): every tool's schema tested for a missing/wrong-typed required field, `wait`'s exact boundary (0 and 15000 accepted; -1, 15001, 1.5, `'soon'` rejected), the signal enum, `planTool`'s subgoal/currentSubgoal validation, every tool's routing to the correct `PageTools` method with the right args, and `summarize()`'s pure-function edge cases. |
| `src/messaging/port.ts`, `src/messaging/contract.ts`, `src/runtime/worker.ts` | `contract.ts` is compile-time-only — no runtime schema anywhere. `createChannel`'s dispatch does `handler(message as Envelope<TIn>)` with zero shape check; `worker.ts`'s `asPanelMessage` only checks `envelope.type` is a known string before casting the payload; `connect()`'s own callback read `envelope.type` before any null/shape check at all. No test anywhere tried a malformed envelope. Two independent reviewers (the `tests/` reviewer and this agent, working separately) converged on the same finding. | high | Added `tests/port.edge.test.ts` (documents the port layer's total lack of shape validation) and `src/runtime/worker.edge.test.ts` (malformed/unknown-type/missing-payload envelopes reaching the worker). **Found and fixed a real bug**: `worker.ts`'s `connect()` callback threw a `TypeError` on a `null`/non-object envelope (verified by reverting the fix and re-running — the new test failed exactly as predicted). Added a one-line defensive guard (`if (envelope === null \|\| typeof envelope !== 'object') return;`). The deeper gap — no per-message-type payload schema — is architectural and is **recorded as needing a source change**, not fixed: it would mean adding a zod schema per `PanelToWorker`/`WorkerToPanel` variant across the whole contract, a larger design decision than this review's scope. Suggested diff: give `contract.ts` a zod schema per message type (mirroring the existing `FollowerSignalSchema` pattern in `tools.ts`) and have `asPanelMessage` `safeParse` against it instead of casting. |
| `src/host/redact.ts` | Its own doc comment claims "there is no second, weaker definition of 'redacted' anywhere" — false. Its `OPENROUTER_KEY_RE` was `/sk-or-[A-Za-z0-9-]+/g` (no `.`), while the host's own `KEY_SHAPES` in `host/src/log.ts` is `/sk-or-[A-Za-z0-9._-]+/g` (has `.`) — a real OpenRouter `v1.<hex>.<hex>` key would be only partially redacted on the extension side. Both `OPENROUTER_KEY_RE` and `BEARER_RE` were also case-sensitive. No test used a dotted key or a case variant. | high | **Fixed**: added `.` to `OPENROUTER_KEY_RE` and made both patterns case-insensitive (`/gi`). Added `src/host/redact.edge.test.ts`, including a test that mirrors the host's own regex literally so the two cannot silently drift apart again. |
| `src/userscripts/debug.ts` (`DebugSession.rerun`) | A real concurrency bug: `rerun()` read `this.current.id` *after* its `await`, so (a) two overlapping `rerun()` calls on the same script raced on `this.results.set` — whichever resolved *last* won, regardless of which was *started* last, contradicting the documented "replaces the previous result" contract; (b) a `select()` call made while a `rerun()` was in flight would attribute that call's result to the *new* current script's id, not the one it actually ran against. Neither `debug.test.ts` test awaits anything but sequentially. | high | **Fixed**: `rerun()` now captures the target script and a per-script sequence number before the `await`, and only commits its result if it is still the latest issued for that script id when it resolves. Added `src/userscripts/debug.edge.test.ts` (3 tests) proving both failure modes; verified each failed against the pre-fix code by reverting and re-running. |
| `src/userscripts/i03.test.ts` | Two tautological tests: "reports what the world can reach on the page" asserted `report.extensionApis` with `expect.any(Boolean)` for all four fields — passes regardless of the actual values, so the module's central security claim ("all false is the expected result") was never checked. "gates the one network request behind an explicit opt-in" only checked the *generated source string* for `const DO_FETCH = false/true;` — never executed the probe, so the gate's actual behavior (does a fetch happen or not?) was unproven in either direction. | high | Added `src/userscripts/i03.edge.test.ts` (7 tests). Discovered *why* the original test used `expect.any(Boolean)`: WXT's vitest plugin installs a `globalThis.chrome` shim in every test file (verified directly — `typeof (globalThis as any).chrome` is `'object'` even with no import), and `vmUserScriptsApi()`'s `vm.runInThisContext` shares that same realm, so a strict `{chrome:false,...}` assertion would fail for an environment reason unrelated to the userscript's real page-world isolation (the same class of limitation the former `docs/STATUS.md`'s R-02 row flagged for its own claims). The new tests control `globalThis.chrome` directly (delete it / replace it with partial shapes) and assert exact per-field output, and execute the probe with a spied `fetch` to prove zero calls without opt-in and exactly one with it. |
| `host/src/secrets.ts` (`DopplerSecretProvider`) | The one production credential-lookup implementation (C-06) had zero coverage — every existing test only exercises `FakeSecretProvider`. `execFile` is called with an argument array, not a shell string, so there is no injection surface to test, but stdout-trimming, empty-output handling, and error handling were all unverified. | high | Added `host/test/secrets.edge.test.ts` (6 tests), mocking `node:child_process`, driving the real class directly. `host/src/**` is off-limits to edit; no source change was needed here — this was a pure coverage gap. |
| `src/runtime/runManager.ts` | `input.detach()` — the code path that actually releases a debugger attach at the end of a run — was never asserted to run, on any of the three ways a run ends (done, aborted, the handle rejecting outright). This is precisely the "abort mid-run / cleanup the debugger attach" case the task named as required. Separately, `chromeTabsPort()` — the real `chrome.windows.getLastFocused`/`chrome.tabs.query` selection logic the R-01 "last focused window" claim rests on — had zero coverage anywhere; every existing test only proves `RunManager` forwards whatever a fake `TabsPort` returns. | high | Added `src/runtime/runManager.edge.test.ts` (12 tests): `vi.spyOn(EscalatableInput.prototype, 'detach')` proves detach fires on normal completion, abort, and outright rejection, and that a detach() rejection is swallowed rather than surfacing as the run result; direct tests of `chromeTabsPort()` against a mocked `chrome.windows`/`chrome.tabs` for the focused-window-found, fallback-on-throw, fallback-on-no-active-tab, and closed-tab cases. Also documents (does not fix) a small, low-likelihood gap: `refuseReason` lower-cases but does not trim, so a `tab.url` with leading whitespace would not be recognised as `chrome://` — recorded as **needs source change**: `refuseReason` should `.trim().toLowerCase()`. |
| `src/host/native.ts` | `HostClient.appendLog` — the redaction path for panel/worker diagnostics forwarded to the host — had no `describe` block at all. An unrecognised message `type` reaching `#onMessage` was never proven to be a safe no-op (it is, by the switch having no default that throws, but this was unproven). The "resets backoff to initial delay" test never actually forced a prior doubling first, so it could not distinguish "the reset code runs" from "the reset code was never needed." | high (appendLog untested) / med (the rest) | Added `src/host/native.edge.test.ts` (5 tests): `appendLog` redaction and shape, an unknown-type message proven not to throw, and a rewritten backoff-reset test that first forces an actual doubling, then proves the reset specifically brings it back to the initial delay (the old test would still pass if the reset line were deleted). |
| `src/host/fetch.ts` | The entire `input instanceof Request` branch of `resolve()` — header merging, off-origin refusal, and Authorization-stripping for a `Request`-shaped call, as opposed to a plain URL string — was dead in `fetch.test.ts`; every existing test passes a string URL. | med | Added `src/host/fetch.edge.test.ts` (4 tests) covering the same guarantees for a real `new Request(...)`. |
| `src/userscripts/catalog.ts` (`validateUserscript`) | No size cap existed (or was tested) on stored userscript code — an explicitly-named required edge case ("oversized scripts"). An arbitrarily large script would validate and be handed whole to `chrome.userScripts.execute()` and to storage. | med | **Fixed**: added `MAX_CODE_BYTES` (256 KiB) and a rejection when code exceeds it. Added `src/userscripts/catalog.edge.test.ts` (4 tests) for the exact boundary, the end-to-end `saveUserscript` path, and that the size error doesn't mask other validation errors. |
| `src/userscripts/index.ts` (`handleUserscriptMessage`) | The entire `DebugSession`-backed branch of `userscript.run` was untested through the actual message-dispatch path — every `index.test.ts` case omits `context.session`, so this was proven only in isolation, directly against `DebugSession`, in `debug.test.ts`. Separately, no test drove a *failing* script through this entry point with `context.emit` set, so "error line mapped back reaches the run log" was unproven through this specific seam. | med | Added `src/userscripts/index.edge.test.ts` (3 tests): a session reused across two runs, a session switched to a different script mid-flow, and a failing script's console + final error event reaching `emit` through `handleUserscriptMessage` itself. |
| `src/userscripts/runner.test.ts` | Two explicitly-required edge cases were missing: a script with no top-level `return` (implicit `undefined`), and a genuine asynchronous/callback throw (the existing "captures an uncaught error" test manually dispatches an `ErrorEvent` rather than causing a real throw to propagate). | med | Added `src/userscripts/runner.edge.test.ts` (3 tests): no-return, a throw after an awaited `setTimeout`, and a rejected promise awaited inside the script body. |
| `src/agent/graph.ts` | `decideNext` — "the single source of truth for what happens after a Follower step" — is a pure, exported function but was only ever exercised incidentally through full-graph runs, never unit-tested directly (no test forced the tie cases, e.g. `maxSteps` reached *and* `SUBGOAL_COMPLETE` signalled simultaneously). The follower node's `!tool` branch (an unrecognised tool name from the model) was never hit. The leader node's `currentSubgoal` clamp and its `planTool.invoke` failure branch (a model-supplied `subgoals: []` violating the tool's own schema) were never exercised. | med | Added `src/agent/graph.edge.test.ts` (14 tests): `decideNext`'s full priority order unit-tested directly including the maxSteps-vs-signal tie; an unrecognised tool name proven to produce a failed `tool.result` rather than crashing the run; `currentSubgoal` clamp for both an out-of-range-high and a negative index; a failing `planTool.invoke` proven to produce `tool.result{ok:false}` without stalling the run. |
| `src/agent/run.test.ts` (abort) | The existing abort test's bound (`toBeLessThan(20)` against a `maxSteps: 20` run) passes even if abort took another 17 steps to land — it proves the run didn't reach full completion, not that abort stopped it promptly. | med | Added a companion test in `src/agent/run.edge.test.ts` with an exact bound, determined empirically against the real harness (not assumed): abort fires inside the `onEvent` callback for follower step 2, so exactly steps `[1, 2]` occur and exactly two `click` tool calls happen before the run stops — verified by first probing the actual output, then asserting it exactly. |
| `src/agent/run.ts` | `maxSteps`/`planningInterval` boundary values (0, negative) were never driven through `startRun` at all — unknown whether they'd loop forever, throw an opaque LangGraph recursion error, or fail gracefully. | med | Probed empirically first: they turn out to already be validated at runtime by a zod schema over `AgentContext`, producing a graceful `run.ended{status:'error'}` with a clear message. Added 3 tests in `src/agent/run.edge.test.ts` pinning this down as an asserted contract, so a future refactor that drops the validation is caught. |
| `src/agent/checkpointer.ts` (`#hydrate`) | The vendor conformance suite has no case for a corrupted/missing blob row (a channel's blob deleted, or never written, while its `channel_versions` entry still names it). `#hydrate` silently `continue`s over a missing blob — an implicit, previously-unasserted behaviour. | med | Added `src/agent/checkpointer.edge.test.ts` (2 tests): writes a checkpoint through the real `put()`, deletes one blob row directly via `idb`, and proves `getTuple()` hydrates with that channel simply absent (not thrown, not `undefined`-but-present) — turning the implicit behaviour into an asserted contract. |
| `src/input/debugger.ts` | `createChromeDebuggerApi()` — the real callback→Promise adapter over `chrome.debugger`, including `chrome.runtime.lastError` translation — had zero coverage; every test drives `DebuggerInputTier` against a hand-rolled fake. The "attach() itself issues no CDP command" invariant (stated in the module's own doc comment) was never isolated as its own test. A `detach()` rejection's effect on `isAttached()` state was undocumented and untested. | med | Added `src/input/debugger.edge.test.ts` (8 tests): the real adapter's attach/detach/sendCommand success and `lastError` paths, and its `onDetach` forwarding; an isolated "attach() alone sends zero commands" test; a test documenting (not fixing — this is a genuine judgment call about what `chrome.debugger.detach()` failure actually means, not a clear-cut bug) that a rejected `detach()` currently leaves the tier reporting `isAttached()===true`. **Recorded as needing a source-level decision, not a fix**: whether `detach()` should mark itself detached in a `finally` regardless of the browser-side call's outcome. |
| `src/input/select.ts` (`RunInput`) | Only `click()`'s debugger-tier (coordinate) branch was tested; `moveTo`, `typeText`, `press`, and `scroll` each have their own `isRefTier(tier)` branch that was never exercised for a coordinate tier. | med | Added `tests/input/select.edge.test.ts` (5 tests): each method's ref-to-point conversion (or, for `typeText`/`press`, the documented absence of one — they act on whatever has focus) proven against a minimal recording `InputTier` fake, plus a `getBox` failure proven to propagate rather than silently resolving to `(0,0)`. |
| `src/page/accname.ts` | Three spec-correct but unasserted behaviours: a hidden (`display:none`/`aria-hidden`) `aria-labelledby` *target* is exempt from the hidden check (only a direct self-reference cycle was tested, not a hidden target); a mutual two- or three-element `aria-labelledby` cycle was never proven not to infinite-loop (only a single-element self-reference was tested); `aria-label` overriding a native `<label>` was never asserted (only each in isolation). | med / low | Added `tests/page-accname.edge.test.ts` (6 tests) covering all three. |
| `src/page/actions.ts` | Six `fail()` branches in `type()` (unfocusable element, no native value setter, `execCommand` rejected, `execCommand` unavailable) and `scroll()` (no window, `scrollBy` unavailable) were all unreached by any test. | low-med | Added `tests/page-actions.edge.test.ts` (6 tests), each triggering one branch directly (a stubbed-to-throw `focus()`; an element whose direct prototype is jumped past `HTMLInputElement.prototype` so the native `value` setter is genuinely absent while `isConnected` still works; jsdom does not implement `execCommand` at all, so it is installed before being stubbed to return `false`/throw; `document.defaultView` stubbed to `null`; `window.scrollBy` deleted). |
| `src/page/snapshot.ts` (`refFor`) | A reviewer flagged "only proves two different elements get different refs, never that one element visited twice gets the *same* ref" as a coverage gap. On inspection this branch (`if (existing) return existing`) is very likely **unreachable dead code** under the current architecture: `newSnapshotRefs()` wipes the ref table at the start of *every* `snapshot()` call (so the dedup memory cannot survive across calls), and `walk()`'s own `state.seen` `WeakSet` guarantees each node is visited at most once *within* one call. No test can exercise the branch through the public `snapshot()` API without contriving something `refFor` itself (not exported) would need to be called on twice. | low | **Documented, no test written** — writing one would require either exporting `refFor` for direct unit testing or changing `walk()`'s architecture, neither of which this review should decide unilaterally. Recorded as **needs a source-level decision**: either remove the now-apparently-dead branch, or export `refFor` if the guard is meant to protect a future re-entrant call path this architecture doesn't currently have. |
| `src/userscripts/match-pattern.test.ts` | Otherwise thorough table missed two cases: a port in the URL (Chrome match patterns have no port grammar, so it must be ignored, matching or not regardless of port) and a `file:` pattern with a non-empty host (previously unspecified in either direction). | low | Added `src/userscripts/match-pattern.edge.test.ts` (3 tests) pinning down both, matching existing (correct) behaviour. |
| `src/ui/sections/RunSection.test.tsx` (former STATUS.md R-05 citation) | The cited test ("re-enables Run after the run ends") never types a prompt, so the `Run` button is already disabled by the separate empty-prompt guard; the test never even queries the `Run` button, only `Abort` and the ended-run text. It cannot distinguish "Run re-enabled because the run ended" from "Run still disabled because the prompt is empty." | high | **Not fixed** — `src/ui/**` is off-limits to edit or add files to (confirmed under active concurrent development throughout this session via repeated `git diff` checks). **Recorded as needs source/test change**: type a prompt first, then assert the `Run` button's `disabled` becomes `false` after the `run.ended` event, in addition to the existing assertions. |
| `src/ui/components/NumberField.tsx` / `src/ui/sections/SetupSection.tsx` | A genuine bug flagged by the UI reviewer: `NumberField.tsx`'s own doc comment claims out-of-range values are "shown but never committed," but `onChange` fires unconditionally and `SetupSection`'s handler writes straight to `chrome.storage` — clearing the field yields `NaN`, which gets persisted, violating the documented R-04 invariant. The existing test only checks `aria-invalid`/the alert text, never what actually lands in storage. | high | **Not fixed** — same off-limits directory as above. **Recorded as needs source change**: gate `SetupSection`'s `update()` call behind a validity check before writing to storage (or have `NumberField` withhold `onChange` for an invalid value), and add an assertion that reads storage back after clearing the field. |
| `src/ui/state/gate.test.ts` | The cadence-validation test covers `planningInterval: 0`/`2.5` and `maxSteps: 0`/`5000`/`NaN`, but misses the high side of `planningInterval`, negative values for either field, exact boundary values (off-by-one risk in `inRange`'s comparison), `Infinity`, and `planningInterval: NaN` specifically. | med | **Not fixed** (off-limits directory). **Recorded**: add `planningInterval: 101`/`-1`/`NaN`/`Infinity` and exact-boundary-accepted cases (`1`, `100`, `1000`). |
| `src/ui/runlog/SimpleEvents.tsx` | Seven of its ten exported event-renderer components (`ModelTextEvent`, `ObservationEvent`, `InputFidelityEvent`, `UserscriptOutputEvent`, `FollowerSignalEvent`, `RunPausedEvent`, `RunResumedEvent`) have zero direct or indirect test coverage despite real conditional logic (tone mappings, optional-field guards). | med | **Not fixed** (off-limits directory, no new files added there either given the active concurrent editing). **Recorded**: a `SimpleEvents.test.tsx` asserting the `BLOCKED` tone, the escalated-attached/detached text, the screenshot-present badge, and the role badge on `model.text`. |
| `src/ui/runlog/LogEntryView.tsx` | The dispatch `switch (event.kind)` has no runtime `default` — relies entirely on TypeScript exhaustiveness. An unrecognised `event.kind` (version skew, a bad replay payload) silently renders nothing, with no test proving this is actually safe rather than an accident of narrowing. | med | **Not fixed** (off-limits). **Recorded**: a test constructing an unknown-`kind` event (cast through `as any`) and asserting no throw. |
| `src/ui/runlog/format.ts` | `prettyJson`'s own doc comment calls out the cyclic-object case explicitly ("must never take the panel down") — the one branch never actually tested. `formatDuration`'s two boundary transitions (1000ms, 10000ms) are only tested mid-range. | med | **Not fixed** (off-limits). **Recorded**: a self-referential object through `prettyJson`; `formatDuration(1000)` and `formatDuration(9999)` vs `formatDuration(10000)` at the exact boundaries. |
| `src/ui/sections/UserscriptsSection.test.tsx` | No test for a very large script body, a script with a syntax error (proving the component does no client-side validation and lets `result.error` carry it), or a rapid double-click on Run (the button has no visible debounce guard). | med | **Not fixed** (off-limits). **Recorded** as three test sketches. |
| `src/ui/state/useConfig.ts`, `src/ui/runlog/RunLog.tsx`, `src/ui/components/ModelSelect.tsx` | Minor gaps: both `.catch()` swallow-and-continue branches in `useConfig` untested; the copy-button's `setTimeout` revert untested (not currently flaky — nothing awaits it — but unproven); `ModelSelect` with a `value` no longer present in the model list untested. | low | **Not fixed** (off-limits). **Recorded** as test sketches. |
| `src/ui/sections/SetupSection.test.tsx` | One tautological test: "explains that escalated input raises Chrome's debugger banner" renders a static string present regardless of any state/prop. | low | **Not fixed** (off-limits; also not a security-relevant seam). **Recorded** only. |
| former `docs/STATUS.md` — R-13 citation | Cited only `tests/input/debugger.test.ts`'s "never sends Runtime/Page/DOM/Emulation commands across a mixed run", which is proof-by-omission (it can't fail from a regression that adds a `Runtime.*` call anywhere the five tested public methods don't reach) — the file's own "refuses a non-Input command if one were ever attempted" test is the one that actually pokes the guard and proves refusal. | med (f) | **Fixed** (at the time): STATUS.md's R-13 row was updated to cite the stronger test by name, and notes the omission-only nature of the original citation. |
| former `docs/STATUS.md` — R-01, I-01, I-03, R-10, R-12, C-06 citations | Citations that were accurate as far as they went, but proved less than the row's prose implied (R-01's "last focused window" claim proven only via a fake `TabsPort`; I-01's "attach itself issues no CDP command" proven only incidentally; I-03's two cited tests were the tautological ones fixed above; R-10's "replaces the previous result" proven only sequentially; R-12 and C-06 missing the `Request`-shape and dotted-key and real-`DopplerSecretProvider` coverage added above). | med (f) | **Fixed**: all six rows' "Proving test(s)" columns updated to cite the new, stronger tests alongside (or, for I-03, in place of) the originals. Only that column was touched, per instructions. |
| `host/src/extlog.ts`, `host/src/runlog.ts` | No byte limit anywhere on `message`/`stack`/`event` before writing to disk — the only ceiling in the whole pipeline is the native-messaging frame limit (64 MiB) in `framing.ts`. A single call can append tens of MB with no rejection, rotation, or truncation. | high (c) | **Not fixed** — `host/src/**` is off-limits to edit. **Recorded as needs source change**: add a `MAX_MESSAGE_BYTES` constant and a `bad_request`/`io`-style rejection in `toEntry()`/`appendRunLog()`; suggested test once fixed: `expect(() => toEntry({..., message: 'x'.repeat(10*1024*1024)})).toThrow(ExtLogError)`. |
| `host/src/trigger.ts` (`start()`) | A real TOCTOU window: `server.listen()` resolves (socket already connectable) before `chmod(p, 0o600)` runs, so the socket briefly carries the process umask's default mode rather than 0600. The existing "binds with mode 0600" test only checks the end-state, not the transition. | high (c) | **Not fixed** — `host/src/**` is off-limits. **Recorded as needs source change**: bracket `listen()` with a restrictive `process.umask(0o077)` (save/restore) so the socket is created with safe permissions atomically, rather than relying on a post-hoc `chmod`. |
| `host/src/cassette.ts` (`CassetteStore`) | `fileFor(key)` does `path.join(dir, \`${key}.json\`)` with zero validation of `key`. Safe today only because the sole caller always derives `key` via `cassetteKey()` (a sha256 hex digest) — the class itself provides no defense-in-depth against a future caller passing an arbitrary string. | med (c) | **Not fixed** — `host/src/**` off-limits. **Recorded as needs source change**: `if (!/^[0-9a-f]{64}$/.test(key)) throw` in `fileFor`. |
| `host/test/dispatcher.test.ts`, `host/test/trigger.test.ts` | Neither sets `NB_HOME`/`XDG_DATA_HOME`, unlike `extlog.test.ts` which correctly does — both write real log lines to the actual `~/.local/share/nanobrowser/host.log` on whatever machine runs the suite, every run. `extlog.test.ts`'s own cleanup is inside each test body rather than a top-level `afterEach`, so a failed assertion skips cleanup and leaks the temp dir. | med (e) | **Not fixed** — these are pre-existing test files (not new files this review adds), and per the instruction to avoid colliding with concurrently-active agents (confirmed: `host/test/dispatcher.test.ts` and `host/test/harness.ts` were both under active concurrent edit during this session), existing test files were deliberately left untouched. **Recorded**: both files should adopt `extlog.test.ts`'s `NB_HOME` override pattern (in a proper top-level `afterEach`, not inline). |

## Positive findings (evidence that held up)

- `tests/page-snapshot-golden.test.ts` is a model golden test, not an over-broad one: an
  exact `toBe(EXPECTED)` string comparison against a small, purpose-built fixture
  exercising role mapping, disabled state, `aria-hidden` decoration, a `display:none`
  sibling, and ref numbering together. A real regression in any of those would fail it
  directly.
- `tests/input/support/rng.ts` is a correctly seeded, deterministic PRNG (verified by
  its own "is deterministic for a given seed" test) — no `Math.random()`-driven
  flakiness anywhere in the input suite.
- `src/agent/checkpointer.test.ts` is a real vendor conformance suite run against the
  real `IndexedDBSaver` on `fake-indexeddb`, not a mock.
- `src/runtime/smoke.test.ts` and `src/agent/graph.test.ts` run the real compiled graph
  with only the LLM and the page faked — the right seam to fake — so cadence,
  handoff, and routing logic all execute for real.
- `src/runtime/pageTools.test.ts` fakes only the Chrome-API boundary (`FakeDriver`,
  `FakeDebuggerTier`); `EscalatableInput`, the input tiers, and `selectTier` are all
  real.
- `src/userscripts/match-pattern.test.ts`'s table (before this review's additions) was
  already genuinely thorough against the real parser, not a fake.
- `src/userscripts/testing.ts`'s `vmUserScriptsApi()` really executes wrapped code with
  `node:vm`, not a stub that echoes its input — this is what makes the wrapper's
  line-offset math and console-capture behaviour testable at all.
- `host/test/runlog.test.ts`'s `runId` validation table (`../escape`, `a/b`, `a.b`,
  overlong, non-string) and `host/test/dispatcher.test.ts`'s "rejects a bad runId
  without writing anything" are genuinely thorough proof of the filename/path-handling
  seam this task called out by name.
- `tests/page-driver.test.ts`/`tests/page-handler.test.ts` assert listener/timer
  cleanup (`updatedListenerCount()`) after error paths, not just the happy path — real
  negative-path proof for R-02.

## The suite's real coverage story, in short

Where this suite is strong, it is strong for the right reason: the seams that are
faked are the ones that actually cross a browser-API or IndexedDB boundary (Chrome
APIs, `chrome.debugger`, `chrome.userScripts`), while the logic on this side of that
boundary — routing, cadence, validation, redaction, match-pattern matching, the
accessible-name algorithm — mostly runs for real against real inputs. The golden
snapshot test is tight. The RNG is deterministic. The vendor checkpoint suite is a real
conformance suite, not theater.

Where it was weak before this pass, it was weak in a consistent pattern: thin,
easily-testable pure logic (a zod schema, a pure routing function, a redaction regex)
that had *no* test file at all, righteously present but never isolated as its own
claim (proof-by-omission rather than proof-by-refusal), or a genuinely concurrent code
path (`DebugSession.rerun`, `input.detach()` on run end) that every existing test
happened to exercise only sequentially or only in isolation. Two of those turned out to
be real bugs (`redact.ts`'s regex drift, `debug.ts`'s stale-result race), not just
missing tests — both are fixed and covered by regression tests now. A third
(`worker.ts`'s null-envelope crash) was found via a test aimed at a different gap
entirely (no runtime message validation) and fixed the same way.

The remaining open items split cleanly into two kinds: architectural gaps this review
deliberately did not fix because the source lives in an off-limits or actively-being-edited
file (the UI directory's `NumberField`/`RunSection` issues, the host's size caps and
TOCTOU chmod window, the messaging layer's total absence of runtime payload
validation), each recorded above with a concrete suggested diff; and one apparent
dead-code branch (`snapshot.ts`'s `refFor` dedup guard) that this review chose to flag
rather than paper over with a contrived test.

## Before / after tallies

Real command output, pasted verbatim.

**Before this review's Phase 2 work** (root `pnpm test`, immediately after the five
Phase 1 review agents were launched, before any test or source file in this review was
touched):

```
 Test Files  41 passed (41)
      Tests  1185 passed (1185)
ok: manifest has no web_accessible_resources
ok: manifest has no externally_connectable
ok: manifest has no content_scripts
ok: no world: "MAIN" in source
stealth invariants: all clear
```

Host (`cd host && pnpm test`), same point in time:

```
 Test Files  6 passed (6)
      Tests  94 passed (94)
```

**After** (root `pnpm test`, final run, immediately before committing this review):

```
 Test Files  68 passed (68)
      Tests  1430 passed (1430)
ok: manifest has no web_accessible_resources
ok: manifest has no externally_connectable
ok: manifest has no content_scripts
ok: no world: "MAIN" in source
stealth invariants: all clear
```

Host (`cd host && pnpm test`), same final run:

```
 Test Files  10 passed (10)
      Tests  138 passed (138)
```

`pnpm typecheck` (root) and `pnpm typecheck` (host): both clean, no errors, immediately
before commit.

Note on the totals: this repo had multiple other agents actively committing to it
throughout this review (confirmed by `git log` and live file-change notifications
during the session — see "A note on timing" above), so the file/test counts above are
the real, current state of the whole tree at commit time, not an isolated before/after
delta for this review's own work alone. This review's own contribution, specifically:
**20 new `*.edge.test.ts` files** (one file, `src/agent/tools.edge.test.ts`, was swept
into another agent's commit before this review's own commit — confirmed unchanged
since, via `git diff`, so it is not re-added here), and **4 genuine source bugs found
and fixed** outside the off-limits list: `src/host/redact.ts` (regex drift + case
sensitivity), `src/userscripts/debug.ts` (stale-result race), `src/runtime/worker.ts`
(null-envelope crash), and `src/userscripts/catalog.ts` (a missing size cap added,
rather than a behavioral bug fixed).
