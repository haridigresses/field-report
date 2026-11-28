# Field Report Workflow

Field Report gets AI coding agents' changes reviewed by three independent seats (`correctness`, `design`, `intent`) before a non-draft pull request opens. Reviews are keyed automatically to `(repository, branch, commit HEAD)`—there is no branch registration and Field Report never merges.

## Core Rules

1. **No non-draft PR before MRR is `READY`.**
   - `PreToolUse` hooks (Claude Code, Cursor) and the `~/.local/bin/gh` wrapper block non-draft `gh pr create`, `gh pr ready`, `gh api` pull-request open/ready calls, and GitHub MCP PR-open calls in enabled repos until `fr gate open` is `READY`. (This local boundary prevents cooperative/habitual agent skips without repo clutter; a required GitHub status check is the optional backstop against raw HTTP calls.)
   - Opening a **Draft PR** (`gh pr create --draft`) before MRR is allowed so CI can run early. Whenever an agent mentions or hands off a pre-MRR Draft PR, it must explicitly tell the user that MRR has not been run yet.
   - Humans can mark any Draft PR ready on GitHub, invoke the system `gh` binary by full path (or `~/.local/bin/gh.real` if `gh` lived in `~/.local/bin`), accept findings (`fr accept <F-id> --reason "<reason>" --actor "<name>"`), and merge.

2. **Three seats, strict context separation.**
   - **`correctness`** and **`design`** see **only** `git diff <baseHead>..<head>` (plus `merge-ready-review.md` if present and their own open findings on a rerun)—zero session history.
   - **`intent`** receives two strictly separated sections alongside the diff:
     1. **`USER CONTRACT` (authoritative):** A pre-existing/signed-off BRR plan (only auto-loaded from `baseHead`, never from candidate-edited files in the diff) + verbatim user prompts captured for the session (`UserPromptSubmit` / `beforeSubmitPrompt` hook, stored locally in `prompts/<project>/<session>.jsonl` with a 14-day retention window and capped at 40 KB when sent to the configured `intent` seat provider, with later prompts overriding earlier ones). The `intent` seat composes its **Intent Playback** (`intentSummary`) strictly from this section.
     2. **`BUILDER TECHNICAL RATIONALE` (non-contract context):** `git log <baseHead>..<head>` + optional `fr mrr --notes "..."`. Explains technical file/dependency mechanics only; never excuses unrequested product scope.

3. **Convergence without model shopping.**
   - Each seat's `~/.config/field-report/config.json` entry lists ordered models (`codex`, `claude`, `cursor`, `agy`, `devin`, or `native`). Fallbacks run **only** when an earlier launcher fails to start—never after a valid `NO_GO`. (`--brief` / `--record` is accepted only when `launch: "native"` is explicitly configured for that seat, and only one brief may be issued per seat per commit HEAD.)
   - One review per seat per exact commit HEAD.
   - Fixing a `NO_GO` on a new commit and running `fr mrr` reruns **only** the blocked/missing seat(s); earlier `GO`s carry forward and report unreviewed commit deltas.
   - Unlikely or debatable findings can be cleared only by the user's explicit acceptance: `fr accept <F-id> --reason "<reason>" --actor "<human-name>"`.
   - Unsettled product choices return in `questions` for the user rather than triggering guesswork.
   - Upgrading from schema v2 (workstreams/delegations) to schema v3 (branch-keyed reviews) is an intentional hard cut: back up `~/.local/state/field-report`, prune legacy `workstreams`/`reviews`/`delegations`/`dispositions`/`events`, and run `fr init`.

4. **Calm post-open CI & thread hygiene (`fr gate bots`).**
   - During post-open fix churn, use `fr crr`; run `fr mrr --all` only when the user asks for final MRR.
   - **Bot-opened review threads:** Batch code fixes, push once, and **resolve fixed bot threads silently**. Post a short reply *only* when declining a suggestion.
   - **Human-opened review threads:** Fix or post **at most one** concise reply, then leave the thread for the human reviewer to resolve. Never comment twice when the latest comment is already yours.
   - **Never post `@codex review` or `@bot` triggers** unless the user explicitly asks.

5. **Tabula Rasa Review (TRR) & Build-Ready Review (BRR).**
   - **BRR** (`brr` skill): Multi-PR directional planning before building; user sign-off is the gate, and `fr mrr` treats the BRR plan as authoritative for `intent`.
   - **TRR** (informational, unrecorded): When the user asks for TRR on a large/long-lived branch, launch three fresh read-only reviewers on the default models from `fr seats` asking what to slash/simplify and whether to stay on the branch or rebuild. Present the three prose writeups directly; do not record them as MRR.
