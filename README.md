# Field Report

Field Report is a thin control loop around a delivery unit. It binds repo, branch, claim, and owner session; records CRR and mixed-provider MRR; and gates readiness for CI bots. It does not launch reviewers, open pull requests, or merge.

Agent Fixes owns sessions, names, and todos. Each target repository's `merge-ready-review.md` owns merge quality. Cursor Cloud Agents reach Sol and Fable on this host through My Machines when a worker is online.

## Core loop

- Coordinators and owners name themselves (`fr identity`, then AF save). The user does not name agents. Reviewers stay unnamed and off AF.
- Before you run `git commit` on a commit you intend to keep, stop and run CRR (1–2 subagents, local models first, scores required). A green checkout hook is not CRR. WIP or amend is owner judgment. Findings are for the owner on that staged tree, not a durable ledger. CRR records still persist; they do not enter the SHA-by-SHA finding ledger. `fr context` always prints the latest scores and structural risk (higher = more risk), even when the gate is blocked.
- Keep a one-line next action with `fr update <id> --next`. It is a sticky note, not a todo ledger.
- MRR (Sol / Grok / Fable personas) before a PR is opened. After that, CRR through feature work and bot cycles. Final MRR only when the user asks. The agent may argue that the delta is not substantive enough to re-run the panel (diff size is a proxy for sensitivity, not the test). The user's word always rules. A skip is `fr review waive` after explicit agreement; it records a nonblank actor and dies if HEAD moves. Durable findings live on MRR. Attempt each preferred model once after it is actually started; two GOs can pass when a lane fails.
- Do not auto-open a PR. After `fr gate open`, the owner or the user may open one.
- After bots/CI, `fr gate bots` is merge-readiness evidence, not merge permission. An empty GitHub check rollup keeps that gate blocked.
- Borderline CI flake vs real: consult Sol or Grok once. Not a hard gate.
- Field Report never merges.

## State

Canonical mutable state lives outside the source checkout:

```text
~/.local/state/field-report/
  config.json
  projects/
  workstreams/
  reviews/
  delegations/
  waivers/
  events/
  projection.json
```

Override this location in tests or isolated environments with `FIELD_REPORT_STATE_ROOT`.

## Install

```bash
node scripts/install.mjs
fr init
```

The installer writes `~/.local/bin/fr` and links the same canonical skill sources into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`. It refuses to replace a real directory at any of those paths.

Add repositories deliberately and install hooks explicitly:

```bash
fr project add aon --label AON --repo /path/to/aon --github owner/aon
fr hook install aon
fr hook status aon
```

Agents may self-register an unbound branch with `fr create`, or bind the correct existing outcome with `fr update --branch <current> --owner-task <current-task>`. The checkout hook only checks that the branch is bound. It does not run a review panel and must not grow one.

Repo `.cursor/permissions.json` is Auto-review classifier steering so seated `codex` / `fr-cursor-review` / `claude` launches are not treated as sensitive egress. It is not a Cursor IDE executable allowlist; that remains Settings → Agents → Approvals & Execution.

Do not wrap `git commit`, add `fr catchup` / heartbeat, collapse MRR into a family panel, or put product questions in Field Report. Those were previous iterations.

## My Machines

Cursor Cloud Agents can invoke Sol (`codex`) and Fable (`claude`) on this host when a My Machines worker is running for the target checkout:

```bash
fr machines status
fr machines worker
```

Start the printed `agent worker start --name local` command (one daemon; extra checkouts are repeatable `--worker-dir` flags) and keep it running. Route a Cloud Agent to this host from the environment picker, or with `worker=local` / `machine=local` from Slack, GitHub, or Linear. See `docs/mymachines.md`. Prefer native same-type launch; Cloud Agents use the CLI. Use ordinary `claude`, never `claude-aws`.

## Flow

```bash
fr identity --role owner
fr create aon-example --project aon --title "Example" --outcome "Deliver the bounded outcome" --branch cursor/example
fr context aon-example
fr update aon-example --next "CRR the staged tree, then commit"
fr workflow workstream

# Before git commit on a commit you intend to keep:
fr review brief aon-example --kind crr --role crr
fr gate crr aon-example

fr review brief aon-example --kind mrr --role deep-code-review
fr review brief aon-example --kind mrr --role structural-challenge
fr review brief aon-example --kind mrr --role fable-challenge
fr gate open aon-example
# Owner or user may now open a pull request. Field Report does not.
# Feature work and bot cycles use CRR. Do not re-run MRR because HEAD moved.

# When the user asks for final MRR, commission the panel on the current HEAD — or, only after they agree to skip, record:
# fr review waive aon-example --reason "<why the delta is not substantive>"

fr gate bots aon-example
```
