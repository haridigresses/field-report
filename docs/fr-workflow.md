# Field Report Workflow

Field Report gets AI coding agents' changes reviewed by three independent seats (`correctness`, `design`, `intent`) before a non-draft pull request opens. Reviews are keyed automatically to `(repository, branch, commit HEAD)`—there is no branch registration and Field Report never merges.

## Core Rules

1. **No non-draft PR before MRR is `READY`.**
   - `PreToolUse` hooks (Claude Code, Cursor) and the `~/.local/bin/gh` wrapper block non-draft `gh pr create`, `gh pr ready`, and GitHub MCP PR-open calls in enabled repos until `fr gate open` is `READY`.
   - Opening a **Draft PR** (`gh pr create --draft`) before MRR is allowed so CI can run early. Whenever an agent mentions or hands off a pre-MRR Draft PR, it must explicitly tell the user that MRR has not been run yet.
   - Humans can mark any Draft PR ready on GitHub, invoke the system `gh` binary by full path, accept findings (`fr accept`), and merge.

2. **Three seats, strict context separation.**
   - **`correctness`** and **`design`** see **only** `git diff <baseHead>..<head>` (plus `merge-ready-review.md` if present and their own open findings on a rerun)—zero session history.
   - **`intent`** receives two strictly separated sections alongside the diff:
     1. **`USER CONTRACT` (authoritative):** A signed-off BRR plan (dominates when present) + verbatim user prompts captured for the session (`UserPromptSubmit` / `beforeSubmitPrompt` hook, capped at 40 KB with later prompts overriding earlier ones). The `intent` seat composes its **Intent Playback** (`intentSummary`) strictly from this section.
     2. **`BUILDER TECHNICAL RATIONALE` (non-contract context):** `git log <baseHead>..<head>` + optional `fr mrr --notes "..."`. Explains technical file/dependency mechanics only; never excuses unrequested product scope.

3. **Convergence without model shopping.**
   - Each seat's `~/.config/field-report/config.json` entry lists ordered models (`codex`, `claude`, `cursor`, `agy`, `devin`, or `native`). Fallbacks run **only** when an earlier launcher fails to start—never after a valid `NO_GO`.
   - One review per seat per exact commit HEAD.
   - Fixing a `NO_GO` on a new commit and running `fr mrr` reruns **only** the blocked/missing seat(s); earlier `GO`s carry forward and report unreviewed commit deltas.
   - Unlikely or debatable findings can be cleared by the user's explicit acceptance: `fr accept <F-id> --reason "<reason>"`.
   - Unsettled product choices return in `questions` for the user rather than triggering guesswork.

4. **Calm post-open CI & thread hygiene (`fr gate bots`).**
   - During post-open fix churn, use `fr crr`; run `fr mrr --all` only when the user asks for final MRR.
   - **Bot-opened review threads:** Batch code fixes, push once, and **resolve fixed bot threads silently**. Post a short reply *only* when declining a suggestion.
   - **Human-opened review threads:** Fix or post **at most one** concise reply, then leave the thread for the human reviewer to resolve. Never comment twice when the latest comment is already yours.
   - **Never post `@codex review` or `@bot` triggers** unless the user explicitly asks.

5. **Tabula Rasa Review (TRR) & Build-Ready Review (BRR).**
   - **BRR** (`brr` skill): Multi-PR directional planning before building; user sign-off is the gate, and `fr mrr` treats the BRR plan as authoritative for `intent`.
   - **TRR** (informational, unrecorded): When the user asks for TRR on a large/long-lived branch, launch three fresh read-only reviewers on the default models from `fr seats` asking what to slash/simplify and whether to stay on the branch or rebuild. Present the three prose writeups directly; do not record them as MRR.
