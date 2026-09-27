# Working agreements for this repo

Guidance for Claude and any subagent working on nanobrowser-v2. These are rules about
**how agents behave**, not constraints to hard-code into the product. If a rule here would
also make sense as a runtime check, ask before building it: the user does not want their own
tool telling them no.

## Models and money

Use **free OpenRouter models** for runs, defaults, scripts and docs. The pair the user
named is `nvidia/nemotron-3-ultra-550b-a55b:free` (Leader) and
`nvidia/nemotron-3.5-lightning:free` (Follower).

Never start a run on a paid model without asking first. On 2026-09-03 a run was made on a
paid pair without permission, and the user said: "i didn't authorize a paid pair... just use
the free nemotron pair." The key is the user's own, out of their Doppler workplace, so every
paid token is their money.

The user is free to select whatever model they like in the panel. Do not block them, warn
them on every render, or filter their catalog down without being asked. The restriction is
on agent-initiated runs.

If a free model turns out to be too weak for a task, fix the tooling first: deterministic
tools, smaller snapshots, a userscript that does the extraction. Reach for a paid model only
after asking.

## Requirements

`REQUIREMENTS.md` is canonical and written from the user's own words. Never edit, reword,
extend or reinterpret it. Findings go in `docs/research/`; open work and status go in
GitHub issues, and proof goes in test names, not in a status doc.

Distinguish a **requirement** (a measure of success) from a **constraint** (comply, but
choose how). When something is genuinely unknown, write it down as a question to
investigate rather than deciding on the spot and moving on.

## Evidence

A claim is not evidence. When reporting that something works, paste the real output: test
tallies, run-log lines, the actual error text. "Tests pass" on its own is not a result.

Prefer a real failure over a fake success. If part of a task is blocked, finish everything
else and say plainly what is left and why.

## Subagents

Launch every subagent with an explicit `model:` of `opus` or `sonnet`. Research uses the Exa
tools, not the user's Chrome. When several agents run at once, give each one a disjoint set
of files, and have them commit with `git add <paths>` — never `git add -A`.

## The user's machine

- The extension runs in the user's **real Chrome** with their **real logged-in sessions**.
  Treat every run as acting as them.
- Never enter credentials, never sign in, never solve a bot challenge. If a page demands a
  login, the correct outcome is `blocked`.
- Do not run `doppler secrets` in a way that prints values.
- The extension never holds the API key. The native host attaches it.
- Do not hammer third-party sites with automated navigation while testing.

## Style

Comments explain **why**, not what. Test names are sentences describing the behaviour being
proved. Match the surrounding code rather than importing a new style.
