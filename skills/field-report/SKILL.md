---
name: field-report
description: Run Field Report's pre-commit CRR, three-seat pre-PR MRR, and calm post-open CI/bot-thread checks in enabled repositories.
---

# Field Report

Field Report gates non-draft pull requests on three independent reviews (`correctness`, `design`, `intent`) keyed automatically by repository + branch + commit HEAD. There is **no branch or workstream registration**. Field Report never merges.

## 1. Check whether this repository uses Field Report

Run `fr status`.
- If it prints `No Field Report project matches this checkout`, this repository is not enabled—skip Field Report and do not run `fr project add` unless the user asks.
- Otherwise note the project's base branch, `Todos:` destination, and `Plans:` home printed by `fr status`.

## 2. Product & architecture judgment stays with the user

- Read the repository's `merge-ready-review.md` if present.
- Product behavior, domain facts, migrations, security boundaries, and meaningful scope additions belong to the user—do not infer them from existing code or schema. Ask the user plainly before implementing unsettled product choices.
- File real follow-up todos only in the project's `Todos:` destination (`gh issue create` for GitHub Issues by default, or the configured Linear/Notion/Ref connector).

## 3. Before keeping a commit: `fr crr`

Before committing work you intend to keep (skip for quick WIP/amend checkpoints), run:

```bash
fr crr
```

Fix any real defects it flags. If no CLI reviewer is configured, `fr crr --brief` prints an isolated review brief you can run in a fresh read-only subagent with no MCP servers or conversation history.

## 4. Before opening or readying a PR: `fr mrr`

1. Commit all changes and fetch `origin` so `origin/<base>` is current.
2. Run three-seat MRR directly:
   ```bash
   fr mrr [--notes "brief technical rationale for touched dependencies"] [--brr path/to/plan.md]
   ```
   - `fr mrr` runs `correctness`, `design`, and `intent` in parallel using `~/.config/field-report/config.json`, falling back down a seat's model list *only* if an earlier CLI cannot start.
   - If a seat uses `launch: "native"`, run `fr mrr --brief --seat <role>`, execute the prompt in a fresh read-only subagent (zero owner context, no MCP), and record its JSON output with `fr mrr --record <file> --brief-id <uuid>`.
3. **Converging on `NO_GO`:**
   - Fix real defects on a new commit and rerun `fr mrr` (by default `fr mrr` reruns **only** missing or `NO_GO` seats; earlier `GO`s carry forward and show unreviewed commit deltas).
   - Never shop for a second review on the exact same commit HEAD.
   - For an unlikely, fail-safe, or debatable finding, bring it to the user; **only** after the user explicitly accepts it, record `fr accept <F-id> --reason "<user's reason>"`.
   - Surface any `questions` printed by MRR directly to the user.
4. **Draft PRs vs. Open PRs:**
   - Non-draft `gh pr create` and `gh pr ready` are **blocked** by Field Report until `fr gate open` is `READY`.
   - Opening a **Draft PR** (`gh pr create --draft`) before MRR is allowed when running CI early is useful—if you mention or hand off a Draft PR before MRR is `READY`, **explicitly tell the user that MRR has not been run yet**.
   - Never merge a PR.

## 5. After a PR is open: CI & calm review-thread handling

- Use `fr crr` during post-open fix churn. Do **not** rerun 3-seat MRR on every push; run `fr mrr --all` only when the user asks for final MRR.
- **Calm comment rules (no PR comment spam):**
  - **Bot threads:** Batch fixes into one push and **resolve fixed bot threads silently**—post a short reply **only** when declining a bot suggestion.
  - **Human threads:** Fix or post **at most one** concise reply, then **leave the thread for that person to resolve** (never resolve a human-opened thread, and never post a second reply when the latest comment is already yours).
  - **No unprompted bot triggers:** Never post `@codex review` or any `@bot` trigger comment unless the user explicitly asks.
- Run `fr gate bots` to verify CI checks ran and passed and review threads are settled before final handoff.
