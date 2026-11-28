---
name: field-report
description: Run Field Report's mechanical commit-time CRR gate, three-seat pre-PR MRR gate, TRR reviews, and calm post-open CI/bot-thread checks in enabled repositories.
---

# Field Report

Field Report mechanically gates commits on a staged-tree **CRR** (`fr crr` + `fr gate commit`) and gates non-draft pull requests on three independent **MRR** reviews (`correctness`, `design`, `intent`) keyed automatically by repository + branch + commit/tree SHA. There is **no branch or workstream registration**. Field Report never merges.

## 1. Check whether this repository uses Field Report

Check the `SessionStart` banner or run `fr status`.
- If `fr status` prints `No Field Report project matches this checkout`, this repository is not enabled—skip Field Report and do not run `fr project add` unless the user asks.
- Otherwise note the project's base branch, `Todos:` destination, and `Plans:` home printed by `fr status`.
- **Subagent & `/swarm` briefs:** Whenever you delegate coding, commits, or PR work to a builder/worker/subagent in an enabled repo, **include Field Report requirements in its brief**. Never instruct a subagent to skip `fr crr` or `fr mrr`.

## 2. Product & architecture judgment stays with the user

- Read the repository's `merge-ready-review.md` if present.
- Product behavior, domain facts, migrations, security boundaries, and meaningful scope additions belong to the user—do not infer them from existing code or schema. Ask the user plainly before implementing unsettled product choices.
- File real follow-up todos only in the project's `Todos:` destination (`gh issue create` for GitHub Issues by default, or the configured Linear/Notion/Ref connector).

## 3. Mechanical commit-time gate: `fr crr`

Enabled repositories enforce a recorded `GO` CRR matching the staged `git write-tree` SHA via `.git/hooks/pre-commit` (`fr gate commit`). Before running `git commit`:

```bash
git add <files>
fr crr
git commit -m "..."
```

Fix any real defects `fr crr` flags, re-stage with `git add`, and rerun `fr crr`. (If no CLI reviewer is configured, `fr crr --brief` + `fr crr --record <file> --brief-id <uuid>` runs an isolated read-only subagent brief.)

## 4. Mechanical pre-PR gate: `fr mrr`

1. Commit all changes and fetch `origin` so `origin/<base>` is current.
2. Run three-seat MRR directly (passing `--session <id>` when shown in `SessionStart` or `fr mrr` prompts):
   ```bash
   fr mrr [--session <id>] [--notes "brief technical rationale for touched dependencies"] [--brr path/to/plan.md]
   ```
   - `fr mrr` runs `correctness`, `design`, and `intent` in parallel using `~/.config/field-report/config.json`, falling back down a seat's model list **only** if an earlier CLI fails to start/authenticate (never on a `NO_GO` or malformed output).
   - If a seat uses `launch: "native"`, run `fr mrr --brief --seat <role>`, execute the prompt in a fresh read-only subagent (zero owner context, no MCP), and record its JSON output with `fr mrr --record <file> --brief-id <uuid>`.
3. **Converging on `NO_GO`:**
   - Fix real defects on a new commit and rerun `fr mrr` (by default `fr mrr` reruns **only** missing or `NO_GO` seats; earlier `GO`s carry forward and show unreviewed commit deltas).
   - Never shop for a second review on the exact same commit HEAD.
   - For an unlikely, fail-safe, or debatable finding, bring it to the user; **only** after the user explicitly accepts it, record `fr accept <F-id> --reason "<user's reason>" --actor "<user>"`.
   - Surface any `questions` printed by MRR directly to the user.
4. **Draft PRs vs. Open PRs:**
   - Non-draft `gh pr create`, `gh pr ready`, and GitHub MCP PR-open calls are **blocked** by `~/.local/bin/gh` and host MCP `PreToolUse` hooks until `fr gate open` is `READY`. Always invoke `gh` on `PATH`.
   - Opening a **Draft PR** (`gh pr create --draft`) before MRR is allowed when running CI early is useful—if you mention or hand off a Draft PR before MRR is `READY`, **explicitly tell the user that MRR has not been run yet**.
   - Never merge a PR.

## 5. After a PR is open: CI & calm review-thread handling

- **Never waive `fr crr` or `fr mrr`**, and **never treat red CI as "pre-existing baseline"** without reading every failing job's log (`gh run view <run-id> --log-failed`) and reporting the exact failure to the user.
- Use `fr crr` before each post-open fix commit. Do **not** rerun 3-seat MRR on every push; run `fr mrr --all` only when the user asks for final MRR.
- **Calm comment rules (no PR comment spam):**
   - **Bot threads:** Batch fixes into one push and **resolve fixed bot threads silently**—post a short reply **only** when declining a bot suggestion.
   - **Human threads:** Fix or post **at most one** concise reply, then **leave the thread for that person to resolve** (never resolve a human-opened thread, and never post a second reply when the latest comment is already yours).
   - **No unprompted bot triggers:** Never post `@codex review` or any `@bot` trigger comment unless the user explicitly asks.
- Run `fr gate bots` to verify CI checks ran and passed and review threads are settled before final handoff. Never merge (`gh pr merge` and MCP merge tools are blocked), and never dispatch `gh workflow run` / `gh release create` without explicit user confirmation.

## 6. BRR & Tabula Rasa Review (TRR)

- **BRR (Build-Ready Review):** For multi-PR planning, load and follow the `brr` skill. Never improvise a single-model substitute.
- **TRR (Tabula Rasa Review):** Informational, unrecorded architectural check when the user asks for a TRR on a codebase or long-lived branch. Run `fr seats` to read the configured default model for each of the 3 seats (`correctness`, `design`, `intent`), launch three isolated read-only reviewers across those configured providers with zero owner framing asking what to slash/simplify and whether to stay the course or rebuild, and present all three prose writeups directly to the user (do not record TRR as MRR).
