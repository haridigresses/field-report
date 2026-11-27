# Field Report

Field Report is a thin control loop around a delivery unit. It binds repo, branch, claim, and owner session; records CRR and three-seat MRR; and gates readiness for CI bots. It does not launch reviewers, open pull requests, or merge.

Each project says where todos go (GitHub Issues by default, or Linear, Notion, or Ref) and where build plans live; Field Report stores only those pointers. Each target repository's `merge-ready-review.md` owns merge quality. Your config file chooses the reviewer models (see [Seats](#seats)). Cursor Cloud Agents reach the host `codex` and `claude` CLIs through My Machines when a worker for that checkout is online.

## Core loop

- Coordinators and owners title their session with the key `fr identity` prints (for example `aon/owner`) where the host allows, so the user can find it. It is a label only. The user does not name agents. Reviewers take no title.
- Before you run `git commit` on a commit you intend to keep, stop and run CRR (1–2 subagents, local models first, scores required). A green checkout hook is not CRR. WIP or amend is owner judgment. Findings are for the owner on that staged tree. `fr context` always prints the latest scores and structural risk (higher = more risk), even when the gate is blocked.
- Keep a one-line next action with `fr update <id> --next`. It is a sticky note, not a todo ledger.
- MRR (three seats whose valid models come from your config file; see [Seats](#seats)) before a PR is opened. Each seat is decided by its review of the commit nearest HEAD (HEAD or an ancestor); READY means every seat's deciding review is a GO, or a NO_GO whose findings the user accepted (`fr review accept`). Earlier GOs carry forward and the gate prints what each seat has not seen. After a fix, rerun only the seat that said NO_GO. A seat reviews each exact head once. Reviewers return unsettled product choices as questions; record the user's answers with `fr decide`. The full rules live in `fr workflow`. Reviews never require permission. After that, CRR through feature work and bot cycles. Final MRR only when the user asks. The agent may argue that the delta is not substantive enough to re-run the panel (diff size is a proxy for sensitivity, not the test). The user's word always rules.
- Do not auto-open a PR. After `fr gate open`, the owner or the user may open one.
- After bots/CI, `fr gate bots` is merge-readiness evidence, not merge permission. An empty GitHub check rollup or an unresolved review thread (bot or human) keeps that gate blocked.
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

Prerequisites: Node 20+, git, `gh` (signed in; `fr gate bots` uses it), and the CLI for each launcher your seat config uses (`codex`, `claude`, `cursor-agent`, `agy`, or `devin`), installed and signed in. Use whichever you have. Every launch except Cursor's runs through `zsh`.

```bash
git clone https://github.com/haridigresses/field-report ~/field-report
cd ~/field-report && node scripts/install.mjs && fr init
fr doctor
```

Keep the clone where it is: the launchers and skill links point into it, and `git pull` updates Field Report. `fr doctor` only reads. It checks Node, git, the `fr` launcher and `PATH`, the skill links, the state root, the seat config, the CLI for each configured model (and, for Cursor and agy, that each model id is in `cursor-agent --list-models` or `agy models`; for `codex`, `claude`, and `devin` it checks only that the CLI runs, not that you are signed in or have credits, so those surface at first launch), `gh`, and each registered project's hook. It exits nonzero while anything is FAIL. Rerun it after editing the config or adding a project.

### Install with your agent

Paste this into Claude Code, Codex, or Cursor:

```text
Install Field Report for me.
1. Clone https://github.com/haridigresses/field-report to ~/field-report (or git pull if it exists), then run: node scripts/install.mjs && fr init
2. Run fr doctor and fix what it reports. For each seat in the config file that fr seats prints on its Config line, ask me which models I have access to and edit the config so every seat's first model is one I can run. Do not guess model ids; for Cursor and agy, use ids from cursor-agent --list-models or agy models.
3. Ask me which repositories to register. For each, run fr project add <id> --label <label> --repo <path> --github <owner/repo>. Ask where todos go (GitHub Issues in that repo by default, or Linear, Notion, or Ref) and where build plans live (docs/plans/ by default); for anything but the defaults run fr project update <id> --todos <service> --todos-reference "<where>" and --plans <service> --plans-reference "<where>".
4. Run fr doctor again. For each project: if doctor says a hook manager (husky, lefthook) owns the pre-commit hook, do not run fr hook install; tell me, and suggest adding `fr gate checkout` to that hook manager. Otherwise run fr hook install <id>.
5. Finish with fr doctor and fr seats, and show me both outputs.
Do not change anything inside my repositories except the git hook in step 4.
```

The installer writes `~/.local/bin/fr` and links the same canonical skill sources into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`. The skills are `field-report`, `repo-coordinator`, `workstream-orchestrator`, `brr`, `fr-grill-me`, and `fr-ask-questions`; the last two are adapted from published skills, with attribution in each file, and carry an `fr-` prefix so they never collide with your own copies. It refuses to replace a real directory at any of those paths.

Run `fr version` to see the running package version, runtime source directory, and that source checkout's Git revision. This identifies which checkout an installed launcher uses, regardless of the current working directory. A runtime without Git metadata reports the revision as unavailable.

Add repositories deliberately and install hooks explicitly:

```bash
fr project add aon --label AON --repo /path/to/aon --github owner/aon
fr hook install aon
fr hook status aon
```

If the repository uses a hook manager (`core.hooksPath`, as husky and lefthook set) or tracks its pre-commit hook in git, `fr hook install` refuses rather than overwrite that file, and `fr doctor` warns. Add `fr gate checkout` to the manager's pre-commit hook instead; `fr hook status` and `fr doctor` then report it as installed.

Todos default to GitHub issues in the project's own repository (agents use `gh issue create`). To send them elsewhere, name the service and, in free text, where in it:

```bash
fr project update aon --todos linear --todos-reference "ENG, label agent-todo"
```

`--todos` is `github`, `linear`, `notion`, or `ref`. The reference is free text: a repo and label for GitHub, a team and label for Linear, a database or page for Notion, a parent ref for Ref. Changing the service drops the old reference unless you give a new one; `--clear-todos-reference` removes it. `fr context` prints it on its `Todos:` line and `fr project list` shows it. Owners need that service's CLI or MCP connector authorized; reviewers never file todos.

Every feature branch of a registered project is a workstream: the first `fr` command or commit on it registers one, named `<project>-<branch>` and owned by the current Codex or Claude Code session when FR can tell which one. It starts without an outcome; CRR reviews the change on its own merits, and MRR refuses until `fr update <id> --outcome <text>` sets one. The base branch and a detached HEAD are never registered. Set the outcome before CRR when you know it: setting it changes the claim, so CRR recorded before then no longer counts. To put an existing outcome on this branch instead, run `fr update <id> --branch <current>`; it takes the branch from a workstream registered for it automatically, as long as that one has no outcome. The checkout hook only binds or registers the branch. It does not run a review panel and must not grow one.

Repo `.cursor/permissions.json` is Auto-review classifier steering so review CLI launches are not treated as sensitive egress. It is not a Cursor IDE executable allowlist; that remains Settings → Agents → Approvals & Execution. Reviews never require permission.

Do not wrap `git commit`, add `fr catchup` / heartbeat, collapse MRR into a family panel, or put product questions in Field Report. Those were previous iterations.

## Seats

Field Report hardcodes no model names. Your config file lists the models valid for each MRR seat and how each model launches. The installer creates it from [`config/config.example.json`](config/config.example.json) at `~/.config/field-report/config.json` (override the path with `FIELD_REPORT_CONFIG`) and never overwrites it.

```json
"design": {
  "models": [{ "id": "gemini-4-neon", "launch": "cursor", "cliModel": "gemini-4-neon-high" }]
}
```

- Each seat lists its valid models. The first is the default; `--model` picks another listed one. A model not listed for a seat cannot review it; add it to the config first.
- The shipped example seats three labs (OpenAI, xAI, Anthropic). That is a suggestion for diversity of thought, not a rule: one model may serve every seat.
- Model ids match through a `cursor-` prefix and effort suffixes, so `cursor-grok-4.6-high` is `grok-4.6`. A model listed in two seats launches the same way in both.
- `launch` is `codex`, `claude`, `cursor` (through `fr-cursor-review`), `agy` (Google's Antigravity CLI), or `devin` (through `fr-devin-review`). `--route native` runs any seat as a native subagent instead. `cliModel` is the id that launcher expects, when it differs (Cursor and agy ids carry effort suffixes).

To edit seats and projects (including each project's plan home) in a browser instead, run `fr ui` and open `http://127.0.0.1:4177/settings`. Model fields suggest your Cursor and Antigravity accounts' models (from `cursor-agent --list-models` and `agy models`) and the models already in your config; any id still works. Remove a project you no longer use with `fr project remove <id>`; add `--with-workstreams` to delete its workstreams and their review records too. The page is local only, checks the config with the same rules as `fr`, and refuses to save an invalid one. When a new model ships, edit the config. `fr seats` prints the resolved panel. Each brief pins its seat's valid list, so editing the config changes new briefs only, never recorded reviews. Upgrading to seat lists is a hard cut: review evidence recorded before it is discarded, not migrated. Delete the `reviews`, `delegations`, `dispositions`, and `waivers` folders under the state root (`~/.local/state/field-report`, or `FIELD_REPORT_STATE_ROOT`), then rerun MRR on open workstreams.

### Plan home

Each project says where its build-ready review (BRR) plans live. The default is `docs/plans/` in the repository.

```bash
fr project update aon --plans ref --plans-reference "Engineering plans"
```

- `--plans` is `repo`, `linear`, `notion`, or `ref`. `--plans-reference` is optional free text naming the team, page, or parent document; it does not apply to `repo`. Changing the service drops the old reference unless you give a new one; `--clear-plans-reference` removes it.
- Field Report only prints it: on the `Plans:` line of `fr context`, in `fr project list`, and in `fr identity`. The agent reads and writes the plan through its host's MCP connector for that service, and asks the user if it has none.
- Plan homes used to live in the config file; a `plans` key there now fails with a pointer to this command.

### Seat names

The seats are `correctness` (bugs, security, data integrity, error paths, tests), `design` (how it is built: whether it is needed, simplicity, boundaries), and `intent` (what it does: whether it matches the stated outcome, claim, and user decisions, and only that).

They were renamed from `deep-code-review`, `structural-challenge`, and `fable-challenge` as a hard cut. Rename those keys in your config file. Reviews recorded under the old names are ignored, not deleted; rerun MRR on open workstreams.

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
git switch -c cursor/example
fr context                          # registers aon-cursor-example
fr update aon-cursor-example --outcome "Deliver the bounded outcome"
fr update aon-cursor-example --next "CRR the staged tree, then commit"
fr workflow workstream

# Before git commit on a commit you intend to keep:
fr review brief aon-cursor-example --kind crr --role crr
fr gate crr aon-cursor-example

fr review brief aon-cursor-example --kind mrr --role correctness
fr review brief aon-cursor-example --kind mrr --role design
fr review brief aon-cursor-example --kind mrr --role intent
fr gate open aon-cursor-example
# Owner or user may now open a pull request. Field Report does not.
# Feature work and bot cycles use CRR. Do not re-run MRR because HEAD moved.

# Earlier seat reviews carry forward. When the user asks for final MRR, rerun the seats on the current HEAD.
# Only when the user explicitly accepts a finding:
# fr review accept aon-cursor-example --finding F3 --reason "<the user's reason>" --actor user

fr gate bots aon-cursor-example
```

## License

MIT; see [LICENSE](LICENSE). Two adapted skills keep their own licenses: `skills/fr-grill-me` (MIT, Matt Pocock) and `skills/fr-ask-questions` (CC BY-SA 4.0, Trail of Bits).
