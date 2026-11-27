# Field Report

Field Report is a thin control loop around a delivery unit. It binds repo, branch, claim, and owner session; records CRR and three-seat MRR; and gates readiness for CI bots. It does not launch reviewers, open pull requests, or merge.

Agent Fixes, when installed, owns sessions and names. Each project's tracker — AF issues or a Linear team — owns todos. Field Report stores only that pointer. Each target repository's `merge-ready-review.md` owns merge quality. Your config file chooses the reviewer models (see [Seats](#seats)). Cursor Cloud Agents reach the host `codex` and `claude` CLIs through My Machines when a worker for that checkout is online.

## Core loop

- When AF is installed, coordinators and owners name themselves (`fr identity`, then AF save); without AF they skip naming. The user does not name agents. Reviewers stay unnamed and off AF.
- Before you run `git commit` on a commit you intend to keep, stop and run CRR (1–2 subagents, local models first, scores required). A green checkout hook is not CRR. WIP or amend is owner judgment. Findings are for the owner on that staged tree. `fr context` always prints the latest scores and structural risk (higher = more risk), even when the gate is blocked.
- Keep a one-line next action with `fr update <id> --next`. It is a sticky note, not a todo ledger.
- MRR (three seats whose valid models come from your config file; see [Seats](#seats)) before a PR is opened. Each seat is decided by its review of the commit nearest HEAD (HEAD or an ancestor); READY means every seat's deciding review is a GO, or a NO_GO whose findings the user accepted (`fr review accept`). Earlier GOs carry forward and the gate prints what each seat has not seen. After a fix, rerun only the seat that said NO_GO. A seat reviews each exact head once. Reviewers return unsettled product choices as questions; record the user's answers with `fr decide`. The full rules live in `fr workflow`. Reviews never require permission. After that, CRR through feature work and bot cycles. Final MRR only when the user asks. The agent may argue that the delta is not substantive enough to re-run the panel (diff size is a proxy for sensitivity, not the test). The user's word always rules.
- Do not auto-open a PR. After `fr gate open`, the owner or the user may open one.
- After bots/CI, `fr gate bots` is merge-readiness evidence, not merge permission. An empty GitHub check rollup keeps that gate blocked.
- Borderline CI flake vs real: consult one seated model (`fr seats`) once. Not a hard gate.
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
  dispositions/
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

Run `fr version` to see the running package version, runtime source directory, and that source checkout's Git revision. This identifies which checkout an installed launcher uses, regardless of the current working directory. A runtime without Git metadata reports the revision as unavailable.

Add repositories deliberately and install hooks explicitly:

```bash
fr project add aon --label AON --repo /path/to/aon --github owner/aon
fr hook install aon
fr hook status aon
```

Todos default to AF issues in the project namespace. To file them in Linear instead (no AF required):

```bash
fr project update aon --tracker linear --linear-team ENG --linear-label agent-todo
```

Changing `--linear-team` drops the old label unless the same command passes `--linear-label`; `--clear-linear-label` removes it. `fr context` prints the tracker on its `Todos:` line and `fr project list` shows it as `linear:<team>[/<label>]`. Owners need the Linear MCP or CLI authorized; reviewers never touch the tracker.

Agents may self-register an unbound branch with `fr create`, or bind the correct existing outcome with `fr update --branch <current> --owner-task <current-task>`. The checkout hook only checks that the branch is bound. It does not run a review panel and must not grow one.

Repo `.cursor/permissions.json` is Auto-review classifier steering so review CLI launches are not treated as sensitive egress. It is not a Cursor IDE executable allowlist; that remains Settings → Agents → Approvals & Execution. Reviews never require permission.

Do not wrap `git commit`, add `fr catchup` / heartbeat, collapse MRR into a family panel, or put product questions in Field Report. Those were previous iterations.

## Seats

Field Report hardcodes no model names. Your config file lists the models valid for each MRR seat and how each model launches. The installer creates it from [`config/config.example.json`](config/config.example.json) at `~/.config/field-report/config.json` (override the path with `FIELD_REPORT_CONFIG`) and never overwrites it.

```json
"structural-challenge": {
  "models": [{ "id": "gemini-4-neon", "launch": "cursor", "cliModel": "gemini-4-neon-high" }]
}
```

- Each seat lists its valid models. The first is the default; `--model` picks another listed one. A model not listed for a seat cannot review it; add it to the config first.
- The shipped example seats three labs (OpenAI, xAI, Anthropic). That is a suggestion for diversity of thought, not a rule: one model may serve every seat.
- Model ids match through a `cursor-` prefix and effort suffixes, so `cursor-grok-4.6-high` is `grok-4.6`. A model listed in two seats launches the same way in both.
- `launch` is `codex`, `claude`, or `cursor` (through `fr-cursor-review`). `--route native` runs any seat as a native subagent instead. `cliModel` is the id that launcher expects, when it differs (Cursor ids carry effort suffixes).

When a new model ships, edit the config. `fr seats` prints the resolved panel. Each brief pins its seat's valid list, so editing the config changes new briefs only, never recorded reviews. Upgrading to seat lists is a hard cut: review evidence recorded before it is discarded, not migrated. Delete the `reviews`, `delegations`, and `waivers` folders under the state root (`~/.local/state/field-report`, or `FIELD_REPORT_STATE_ROOT`), then rerun MRR on open workstreams.

## My Machines

Cursor Cloud Agents can invoke the host `codex` and `claude` CLIs on this host when a My Machines worker is running for the target checkout. Field Report prints the CLI recipe; Cursor owns the worker.

```bash
agent worker start --name local --worker-dir /path/to/this/repo
fr machines invoke codex --prompt-file /tmp/brief.txt --cwd /path/to/this/repo --kind review
```

Start that worker for this checkout only. Route a Cloud Agent from the environment picker, or with `worker=local` / `machine=local`. See `docs/mymachines.md`. Prefer native same-type launch; Cloud Agents use the CLI. Use ordinary `claude`, never `claude-aws`.

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

# Earlier seat reviews carry forward. When the user asks for final MRR, rerun the seats on the current HEAD.
# Only when the user explicitly accepts a finding:
# fr review accept aon-example --finding F3 --reason "<the user's reason>"

fr gate bots aon-example
```
