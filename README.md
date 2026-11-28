# Field Report

Field Report gets AI coding agents' changes reviewed by three independent reviewers (`correctness`, `design`, `intent`) before a non-draft pull request opens. Reviews are keyed automatically by **repository + branch + commit HEAD**—no branch registration, no workstream bookkeeping, and zero files committed into your target repositories. A human merges; Field Report never does.

## How It Works

- **Enable once per repository:** Register a repo with `fr project add <id> --repo <path> [--github owner/repo]`. Every branch and `git worktree` of that repository is covered automatically (matched via `git-common-dir`).
- **Pre-commit sanity check (`fr crr`):** Stateless single-reviewer check on staged or working changes before commits you intend to keep.
- **Three-seat pre-PR review (`fr mrr`):** Spawns `correctness`, `design`, and `intent` in parallel across your configured CLIs (`codex`, `claude`, `cursor`, `agy`, `devin`, or `native` subagents):
  - `correctness` and `design` see **only** the diff (and `merge-ready-review.md` if present)—no session history.
  - `intent` checks the diff against your signed-off **BRR plan** (when present) and verbatim user prompts captured silently via `UserPromptSubmit` / `beforeSubmitPrompt` hooks, kept strictly separate from commit messages / `--notes`.
- **Hard local PR-open gate:** `PreToolUse` hooks (Claude Code, Cursor) and `~/.local/bin/gh` block non-draft `gh pr create` and `gh pr ready` until `fr gate open` is `READY`. Draft PRs (`gh pr create --draft`) are allowed anytime so CI can run early.
- **Convergent reruns:** Fixing a `NO_GO` on a new commit and running `fr mrr` reruns **only** the failing seat; earlier `GO`s carry forward with unreviewed commit deltas shown, or settle via explicit user acceptance (`fr accept <F-id> --reason "..."`).
- **Calm post-open checks (`fr gate bots`):** Verifies GitHub checks ran and passed and review threads are resolved—resolving fixed bot threads silently and leaving human threads for the human reviewer without duplicate comment spam.

## Install

Prerequisites: Node 20+, `git`, `zsh`, `gh` (signed in), and whichever reviewer CLIs your seat config uses (`codex`, `claude`, `cursor-agent`, `agy`, `devin`). Ensure `~/.local/bin` precedes system binary directories on `PATH`.

```bash
git clone https://github.com/haridigresses/field-report ~/field-report
cd ~/field-report && node scripts/install.mjs && fr init
fr doctor
```

Configure models and projects either in `~/.config/field-report/config.json` or in the local Settings UI:

```bash
fr ui
# opens http://127.0.0.1:4177/settings
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
fr crr [--model <id>] [--brief]
fr mrr [--seat correctness|design|intent] [--all] [--model <id>] [--notes <text>] [--brr <file>] [--intent-file <file>] [--session <id>] [--brief] [--record <file> --brief-id <uuid>]
fr accept <F-id> --reason <text> [--actor <who>]
fr status
fr gate open
fr gate bots
fr ui [--port <n>]
```

## State Layout

Canonical runtime state lives outside your repositories at `~/.local/state/field-report` (override with `FIELD_REPORT_STATE_ROOT`):

```text
~/.local/state/field-report/
  config.json
  projects/       # enabled repositories + todos/plans destinations
  branches/       # branch-keyed MRR review JSONL records
  dispositions/   # user finding acceptances
  prompts/        # session-keyed verbatim user prompts
  reports/        # rendered Markdown Field Reports per branch
  briefs/         # native-subagent briefs (when launch="native")
```

## License

MIT; see [LICENSE](LICENSE). Two adapted skills keep their own licenses: `skills/fr-grill-me` (MIT, Matt Pocock) and `skills/fr-ask-questions` (CC BY-SA 4.0, Trail of Bits).
