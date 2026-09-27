# nanobrowser-v2

A browser agent that drives **your** real Chrome, in **your** real logged-in session, and
tries very hard not to look like a robot while doing it.

Two models cooperate: a **Leader** that plans and never touches the page, and a
**Follower** that acts on the page one tool call at a time. You watch both in a side panel
and can pause, resume or abort at any point.

`REQUIREMENTS.md` is the canonical statement of what this must do. It is written from the
user's own words and is never edited by an agent. Proof lives in the tests themselves:
test names are sentences describing the behaviour being proved, and open work lives in
GitHub issues.

---

## The shape of the thing

```
  side panel  ──────┐
  (React, the boss) │
                    ▼
             service worker ──────────► native messaging host  ──► OpenRouter
             (run manager,             (Node; holds the API key,
              message hub)              proxies the LLM stream,
                    │                   writes run logs + artifacts)
                    ▼
             injected page script
             (ISOLATED world, on demand)
                    │
                    ▼
             the page you are looking at
```

Four processes, one job.

**The side panel** owns the configuration. Which models, how the agent perceives the page,
how input is delivered, how often to replan, when to give up. Nothing runs until you have
chosen. It also renders the run log turn by turn, which is the main way you understand what
the agent is doing.

**The service worker** is the hub. It holds the connected panels, owns the run manager and
the LangGraph state machine, and speaks one typed message contract
(`src/messaging/contract.ts`) to everyone.

**The native messaging host** (`host/`) is the daemon. There is no listening TCP port and no
auth token, because Chrome's `allowed_origins` already decides who may talk to it. It reads
the OpenRouter key from Doppler so the extension never holds a credential, streams model
responses back in chunks, appends run logs to `~/.local/share/nanobrowser/runs/`, writes
saved artifacts, forwards extension errors to `ext.log`, and can reload the extension in
place. In dev it also listens on a unix socket so the CLI can start a run.

**The injected page script** is put into the tab only when a run needs it, in the ISOLATED
world, and it writes nothing to the DOM. It produces an accessibility snapshot where every
actionable element gets a `[ref=eNN]` handle, and performs clicks and typing.

Separately from all of that, the agent can **write a userscript and iterate on it**: author
the code, run it in the `USER_SCRIPT` world, read what it returned and what it logged, and
fix it. Scripts it writes must name a concrete http/https host — never every site — and it
can never overwrite one you wrote; the panel marks the ones it did write. It reads a script's
source with `read_userscript` before changing it, and can pass `args` to `run_userscript` to
shorten a long run. A run streams its console lines into the run log as it goes, gives up
after 120 s, and polls a stop flag that the panel's Stop button sets. A run that is stopped,
times out, or hits a challenge page hands back the partial rows it had. The model sees only a
result's `summary`, `meta` and `log`. Rows go to disk through `save_file`, and the panel's Save
JSON writes its last result under `artifacts/panel/`. The bundled `ebay-ram-comps` script is
the only bundled script that makes requests: same-origin GETs of eBay search pages, sent with
your session. A read-only run skips the write scan only for a bundled script whose code is
exactly as shipped. Once you edit a bundled script it is scanned like any other. This needs
**Allow User Scripts** turned on for the extension at `chrome://extensions`, which is off by
default and only you can turn on.

---

## How the agent moves between websites

There is exactly one tab, and it is the tab you are already looking at. The agent never
opens new tabs or windows.

- **Starting somewhere specific.** A run may be given a URL. Before the graph starts, the
  run manager navigates the active tab there. It refuses to run on `chrome://` pages and on
  extension pages, and says so plainly rather than failing obscurely.
- **Moving during a run.** `navigate` is one of the Follower's tools. The model calls it
  with a full URL. Under the hood that is `chrome.tabs.update(tabId, { url })` on the same
  tab, then a wait for the tab to report `status: 'complete'`, with a 30 second ceiling.
- **After every navigation** the injected script is gone, because scripts do not survive a
  navigation. The driver forgets that the tab was injected, and the next snapshot re-injects
  on demand. This is also why the agent is asked to snapshot again after it moves.
- **Links** are usually followed by clicking them like a person would, not by reading the
  href and navigating. `navigate` is for jumping somewhere the page does not link to.

---

## Not looking like a robot

The harness is a normal MV3 extension in a normal Chrome profile. Nothing is spoofed.
Detection is about behaviour, not about the harness, so the effort goes into leaving no
structural tells:

- no `web_accessible_resources`, no `externally_connectable`, no declared `content_scripts`,
  and nothing ever runs in the `MAIN` world
- the page script injects on demand, writes no DOM, and leaves no global behind
- humanised input timing, with mouse paths that curve

`scripts/check-invariants.sh` enforces the four structural rules in CI so a future change
cannot quietly reintroduce a tell.

Input comes in tiers: ordinary in-page events by default, real trusted input through the
Chrome debugger protocol when a site demands it, and an OS-level tier that is designed but
not built.

---

## Models

**Free models by default — a working agreement, not a runtime block.** You can select any
model you like in the panel, paid or free, and nothing in the run path will stop you; the
panel simply marks a paid choice so the cost is never a surprise
(`src/ui/sections/SetupSection.tsx`). The rule that agents must not *start* a run on a paid
model without asking lives in `CLAUDE.md`, where it governs agent behaviour.

An earlier version of this file described a `src/runtime/modelPolicy.ts` that refused paid
runs outright. That mechanism was built, then deliberately removed: a rule about how an
agent should behave had been hard-coded into the product, where it could tell the user no
about their own money. See CLAUDE.md's "Models and money".

Two OpenRouter quirks are handled in `src/agent/models.ts`, both discovered the hard way
during live runs:

- `:free` endpoints exist only under the training data policy, so they must be requested
  with `data_collection: "allow"`. Paid models get `"deny"` because page content is sent
  every step.
- free endpoints intermittently answer `HTTP 200` with a body that has no `choices`, which
  used to crash the SDK. Those replies are rewritten into the status they should have
  carried so the retry policy engages.

---

## Running it

One human action, once ever: load `.output/chrome-mv3` unpacked at `chrome://extensions`.
The extension ID is pinned by a manifest key so it survives rebuilds.

After that the loop is closed and needs no clicking:

```bash
scripts/e2e.sh                    # build → reload → readiness → run → assert
host/bin/nb-run "<prompt>" --url https://example.com
host/bin/nb-status                # host up? key ready? extension connected?
host/bin/nb-reload                # reload the extension in place
host/bin/nb-logs                  # errors the extension forwarded
```

Tests:

```bash
pnpm typecheck
pnpm test                  # extension
cd host && pnpm test       # host
bash scripts/check-invariants.sh
```

---

## Where things live

| Path | What |
|---|---|
| `REQUIREMENTS.md` | canonical requirements, never edited by an agent |
| `docs/host-protocol.md` | the native messaging wire protocol |
| `docs/research/` | the findings the design rests on |
| `src/agent/` | LangGraph graph, tools, state, checkpointer, model handles |
| `src/page/` | accessibility snapshot, actions, the injected script and its driver |
| `src/input/` | input tiers: in-page, debugger/CDP, humanisation |
| `src/runtime/` | run manager, worker message hub, page tools |
| `src/userscripts/` | userscript catalog, matching, runner, the agent's write path, bundled examples |
| `src/ui/` | side panel components, run log, state |
| `host/` | the native messaging host and its CLIs |
