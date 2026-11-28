# Field Report Workflow

Field Report mechanically gates commits on a staged-tree **CRR** (`fr crr` + `fr gate commit`) and gates non-draft pull requests on three independent **MRR** seats (`correctness`, `design`, `intent`) keyed automatically to `(repository, branch, commit/tree SHA)`—there is no branch registration and Field Report never merges.

## Core Rules

1. **Always-loaded across hosts & two mechanical gates (commit CRR + PR-open MRR).**
   - `node scripts/install.mjs` and `fr init` install always-on rules, skills, and lifecycle hooks across Claude Code (`SessionStart`, `PreCompact`, `UserPromptSubmit`, MCP `PreToolUse`, and `~/.claude/CLAUDE.md`), Codex (`~/.codex/AGENTS.md` + `skills`), Cursor (`~/.cursor/rules/field-report.mdc` + `hooks.json` + `skills`), Antigravity (`~/.gemini/config/plugins/field-report`), and Devin CLI (`~/.config/devin`), ensuring orchestrators and `/swarm` leads include Field Report in every task (audits, BRR, TRR, CRR, MRR, and subagent briefs) rather than relying on optional skill discovery.
   - **Commit gate (`fr crr` + `fr gate commit`):** `.git/hooks/pre-commit` on enabled repos chains any existing user hook and blocks `git commit` unless `fr crr` recorded `GO` on the staged `git write-tree` SHA.
   - **PR-open gate (blocks the normal paths):** `~/.local/bin/gh` (running in the actual command `cwd`, pinned to the canonical user state root) blocks non-draft `gh pr create` and `gh pr ready` until `fr gate open` is `READY`, while host `PreToolUse` hooks gate GitHub MCP PR-open/ready tool calls (shell commands are not parsed in `PreToolUse`, so `cd` into worktrees never false-blocks against the session folder). Draft PRs (`gh pr create --draft`) pass through anytime for early CI with a reminder to tell the user MRR has not run. Raw HTTP/API calls (`gh api`, `curl`) are out of scope locally; a required GitHub status check is the optional remote backstop.

2. **Three seats, strict context separation.**
   - **`correctness`** and **`design`** see **only** `git diff <baseHead>..<head>` (plus `merge-ready-review.md` if present and their own open findings on a rerun)—zero session history.
   - **`intent`** receives two strictly separated sections alongside the diff:
     1. **`USER CONTRACT` (authoritative):** A pre-existing/signed-off BRR plan (verified against `baseHead`) + verbatim user prompts captured for the explicit session (`--session <id>` or `FR_SESSION_ID`, capped at 40 KB, 14-day retention, with awareness that one session may span multiple branches/PRs). `fr mrr` never guesses across sessions: if captured sessions exist and neither `--session` nor `FR_SESSION_ID` is set, it asks for `--session <id>`. On hosts without a prompt hook (`codex`), `intent` notes missing prompts as a limitation in `summary` and reviews against commit messages and `--notes` rather than returning `NO_GO`.
     2. **`BUILDER TECHNICAL RATIONALE` (non-contract context):** `git log <baseHead>..<head>` + optional `fr mrr --notes "..."`. Explains technical file/dependency mechanics only; never excuses unrequested product scope.

3. **Convergence without model shopping.**
   - Each seat's `~/.config/field-report/config.json` entry lists ordered models (`codex`, `claude`, `cursor`, `agy`, `devin`, or `native`). Fallbacks run **only** when an earlier launcher fails to start/authenticate—never after a `NO_GO`, timeout, or malformed exit-0 envelope.
   - One review per seat per exact commit HEAD.
   - Fixing a `NO_GO` on a new commit and running `fr mrr` reruns **only** the blocked/missing seat(s); earlier `GO`s carry forward and report unreviewed commit deltas.
   - Unlikely or debatable findings can be cleared only by the user's explicit acceptance: `fr accept <F-id> --reason "<reason>" --actor "<human-name>"`.
   - Unsettled product choices return in `questions` for the user rather than triggering guesswork.

4. **Calm post-open CI & thread hygiene (`fr gate bots`).**
   - During post-open fix churn, run `fr crr` before each fix commit; run `fr mrr --all` only when the user asks for final MRR.
   - **Bot-opened review threads:** Batch code fixes, push once, and **resolve fixed bot threads silently**. Post a short reply *only* when declining a suggestion.
   - **Human-opened review threads:** Fix or post **at most one** concise reply, then leave the thread for the human reviewer to resolve. Never comment twice when the latest comment is already yours.
   - **Never post `@codex review` or `@bot` triggers** unless the user explicitly asks.

5. **Tabula Rasa Review (TRR) & Build-Ready Review (BRR).**
   - **BRR** (`brr` skill): Multi-PR directional planning before building; user sign-off is the gate, and `fr mrr` treats `baseHead` BRR plans as authoritative for `intent`.
   - **TRR** (`field-report` skill): Informational, unrecorded check across the 3 default models from `fr seats` asking what to slash/simplify and whether to stay on the branch or rebuild.
