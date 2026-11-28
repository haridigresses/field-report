# Field Report

Field Report mechanically gates commits on a staged-tree **CRR** (`fr crr`) and gates non-draft pull requests on three independent **MRR** reviews (`correctness`, `design`, `intent`) keyed automatically by **repository + branch + commit/tree SHA**—with zero branch registration and zero tracked files committed into your target repositories. A human merges; Field Report never does.

## How It Works

- **Enable once per repository:** Register a repo with `fr project add <id> --repo <path> [--github owner/repo]`. Every branch and `git worktree` of that repository is covered automatically (matched via `git-common-dir`).
- **Always-loaded across local agent hosts:** `node scripts/install.mjs` and `fr init` configure always-on rules, skills, and lifecycle hooks across **Claude Code** (`~/.claude/CLAUDE.md` + `SessionStart`/`PreCompact`/`UserPromptSubmit`/MCP `PreToolUse` in `settings.json`), **Codex** (`~/.codex/AGENTS.md` + `skills`), **Cursor** (`~/.cursor/rules/field-report.mdc` + `hooks.json` + `skills`), **Antigravity** (`~/.gemini/config/plugins/field-report/{plugin.json,rules/AGENTS.md,hooks.json,skills}`), and **Devin CLI** (`~/.config/devin/skills` + `config.json` hooks when installed), plus repair destructive `--system-prompt-file` `claude` shell aliases so skill loading is never wiped.
- **Mechanical commit-time sanity check (`fr crr` + `fr gate commit`):** Installed in `.git/hooks/pre-commit` on enabled repos (chaining any existing hook via `.field-report-preserved`, and warning in `fr doctor` if `core.hooksPath` points outside `.git`). Blocks `git commit` until `fr crr` records `GO` on the staged `git write-tree` SHA.
- **Three-seat pre-PR review (`fr mrr`):** Spawns `correctness`, `design`, and `intent` in parallel across your configured CLIs (`codex`, `claude`, `cursor`, `agy`, `devin`, or `native` subagents when configured):
  - `correctness` and `design` see **only** the diff (and `merge-ready-review.md` if present)—no session history.
  - `intent` checks the diff against any `baseHead`-verified **BRR plan** and verbatim user prompts captured for the explicit session (`--session <id>` or `FR_SESSION_ID`) via `UserPromptSubmit` / `beforeSubmitPrompt` / `PreInvocation` hooks (14-day retention, capped at 40 KB in the `intent` brief), kept strictly separate from commit messages / `--notes`. On hosts without a prompt hook (`codex`), `intent` notes that limitation in `summary` and reviews against commit messages and `--notes` rather than failing for missing prompts.
- **Blocks the normal PR-open & merge paths:** `~/.local/bin/gh` (evaluating `process.cwd()` where `gh` actually runs, pinned to your canonical user state root) blocks non-draft `gh pr create` and `gh pr ready` until `fr gate open` is `READY` and blocks `gh pr merge` unconditionally in enabled repos, while host `PreToolUse` hooks block explicit-path `/.../gh` bypasses, block MCP PR-open/ready/merge calls, and force human confirmation (`ask`/`force_ask`) on `gh workflow run` / `gh release create`. Draft PRs (`gh pr create --draft`) pass through anytime for early CI with a reminder to tell the user MRR has not run. Raw HTTP tools (`gh api`, `curl`) are out of scope locally; add a required GitHub status check if you want a remote merge backstop.
- **Environment & blind-spot audit (`fr doctor`):** Audits `PATH` order, shell rc footguns (`--system-prompt-file` on `claude`, `alias gh=`), disabled host hooks/plugins, reviewer CLIs & models, and per-project `pre-commit` hooks / `core.hooksPath`.
- **Calm post-open checks (`fr gate bots`):** Verifies GitHub checks ran and passed and review threads are resolved—resolving fixed bot threads silently and leaving human threads for the human reviewer without duplicate comment spam.
- **Read-only General's Battlefield (`fr ui`):** Serves `/` with a live overview across all enabled repos (worktrees, open PRs, 3-seat MRR verdicts, reviewer questions, CI rollup, and bot/human thread status) alongside `/settings`.

## Install

Prerequisites: Node 20+, `git`, `zsh`, `gh` (signed in), and whichever reviewer CLIs your seat config uses (`codex`, `claude`, `cursor-agent`, `agy`, `devin`). Ensure `~/.local/bin` precedes system binary directories on `PATH`.

```bash
git clone https://github.com/haridigresses/field-report ~/field-report
cd ~/field-report && node scripts/install.mjs && fr init
fr doctor
```

Open the General's Battlefield and Settings UI locally:

```bash
fr ui
# opens http://127.0.0.1:4177/ (and http://127.0.0.1:4177/settings)
```

## Commands

```bash
fr version
fr init [--host-hooks]
fr doctor
fr seats
fr project add <id> --repo <path> [--label <label>] [--github owner/repo] [--base main] [--todos github|linear|notion|ref] [--todos-reference <text>] [--plans repo|linear|notion|ref] [--plans-reference <text>]
fr project update <id> [...]
fr project list
fr project remove <id>
fr crr [--model <id>] [--brief] [--record <file> --brief-id <uuid>]
fr mrr [--seat correctness|design|intent] [--all] [--model <id>] [--notes <text>] [--brr <file>] [--intent-file <file>] [--session <id>] [--brief] [--record <file> --brief-id <uuid>]
fr accept <F-id> --reason <text> --actor <who>
fr status
fr gate commit
fr gate open
fr gate bots
fr ui [--port <n>]
```

## State Layout

Canonical runtime state lives outside your repositories at `~/.local/state/field-report` (`fr` commands honor `FIELD_REPORT_STATE_ROOT` for isolated test roots; the `~/.local/bin/gh` wrapper enforces against the canonical user state root):

```text
~/.local/state/field-report/
  config.json
  projects/       # enabled repositories + todos/plans destinations
  branches/       # branch-keyed CRR & MRR review JSONL records
  dispositions/   # user finding acceptances
  prompts/        # session-keyed verbatim user prompts (14-day retention)
  reports/        # rendered Markdown Field Reports per branch
  briefs/         # native-subagent briefs
```

Upgrading from schema v2 (workstreams/delegations) to schema v3 (branch-keyed reviews) is a hard cut: back up `~/.local/state/field-report`, remove legacy `workstreams`, `reviews`, `delegations`, `dispositions`, and `events`, then run `node scripts/install.mjs && fr init`.

## License

MIT; see [LICENSE](LICENSE). Two adapted skills keep their own licenses: `skills/fr-grill-me` (MIT, Matt Pocock) and `skills/fr-ask-questions` (CC BY-SA 4.0, Trail of Bits).
