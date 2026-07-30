# Field Report

A local portfolio field report for Codex task coordination, linked Agent Fixes issues, and GitHub pull requests.

This README describes the product and user-facing CLI. Agent behavior is governed only by `docs/fr-workflow.md`, delivered through `fr workflow`; behavioral corrections are not duplicated here.

Agents and users interact through the `fr` CLI. Field Report owns curated outcome state, readable aliases for exact Codex task UUIDs, and the exact-SHA review ledger. Native Codex task channels carry delegation and messaging; AF supplies only the issue list.

The CLI is local-first and does not require the dashboard server. Canonical workstream updates, event appends, questions, decisions, review passes, policies, and assessment requests go through the same filesystem-backed core used by the HTTP server. A short cross-process lock prevents agents from overwriting one another. Run the server only to view or operate the browser dashboard; use **Refresh sources** when you want it to collect the latest canonical, AF, GitHub, and repository state.

Field Report stores durable Codex task UUIDs separately from their human-readable aliases. Use short, globally unique names and add a repository prefix only to resolve a real collision. `fr session alias <alias> [--id <uuid>]` makes a new primary name while retaining the prior name as a fallback; `fr assign <workstream-id> --session <alias-or-uuid>` accepts either. Codex task-title management can mirror the primary alias into the sidebar for readability; the title is not routing authority. Native Codex delegation and messaging carry live coordination; AF is collected only as the linked issue ledger.

## Install

```bash
node scripts/install.mjs
```

This copies the clean exact local `origin/main` Field Report commit into a stable, commit-addressed release under `~/.local/share/field-report/releases`, writes an `fr` launcher with the absolute Node executable and release path, and keeps canonical workstream data in the main Field Report checkout. It also points the shared Field Report and coordination-role skills for Codex and Claude, Claude's `/fr` command, and quiet Claude session hooks at that exact release. Hooks automatically arm only when the repository and branch match exactly; otherwise they do nothing. The installer refuses uncommitted runtime, workflow, or skill changes.

The installer adds one local managed pre-commit hook to each configured repository. It refuses to overwrite an unrelated hook. The hook exits immediately for humans, unarmed Codex tasks, and work outside a Field Report workstream; an armed Codex workstream is blocked unless its exact base HEAD and staged tree have the required two-Sol panel. This is local protection only and does not add a GitHub check or affect teammates without Field Report.

`fr doctor` reports the installed runtime, canonical data root, and Node executable. It is a compatibility diagnostic, not an onboarding prerequisite; assigned work still begins with the exact `fr onboard <outcome-id> --role <role>` flow.

Common operations:

```bash
fr session alias aon-document-zone --id 019f0000-0000-7000-8000-000000000001
fr create --repo aon --title "Document-zone cutover" --outcome "Move document writes to the canonical audit boundary" --orchestrator 019f0000-0000-7000-8000-000000000001
fr assign aon-document-zone-cutover --session aon-document-zone
fr coordinate aon
fr context
fr catchup
fr mrr aon-document-zone-cutover
fr release-check aon-document-zone-cutover
fr policy aon-document-zone-cutover --mode full --user-authorized
fr onboard aon-document-zone-cutover --role workstream-orchestrator
fr workflow
fr ask "Does attachment history belong in this slice?"
fr checkpoint --summary "Implementation complete; exact-SHA review is next" --status active --gate "Exact-SHA review"
fr reconcile --data '{"summary":"...","chunks":[...]}'
fr assess
fr pass record aon-document-zone-cutover --head 4ad570c2e81ac141fa18cc0893465264b533f637 --verdict CONDITIONAL_GO --role deep-code-review --reviewer codex-sol-high --model gpt-5.6-sol --reasoning high --merge 82 --structural 8 --summary "Contracts hold; one evidence gap remains."
fr commit-review record aon-document-zone-cutover --tree <git-write-tree-sha> --base-head <head-sha> --role deep-code-review --summary "Staged candidate is sound."
fr commit-check aon-document-zone-cutover
fr commit aon-document-zone-cutover --message "Implement reviewed change"
fr hold aon-document-zone-cutover --reason "Exact-head visual proof is missing"
fr pass import aon-document-zone-cutover --file /tmp/review-envelope.json
fr link issue ad.41
fr link commit 4ad570c2 --chunk kernel-timeout
fr reference --path docs/import-principles.md --kind contract --quote "Ambiguity and contradiction surface as reviewable, actionable issues at compile time."
fr watch --once
```

Field Report writes canonical updates immediately. Dashboard-originated writes trigger a debounced external refresh; CLI writes remain local and are incorporated on the next manual source refresh.

CLI updates do not automatically launch the dashboard or collect external sources. This keeps agent writes available when the UI is offline. The next dashboard refresh incorporates them.

AF remains the linked issue ledger; Field Report links issue trees to durable outcomes and milestones. Commit SHAs are delivery evidence, not narrative status. Git plans and contracts remain authoritative in their repositories; Field Report references them by path, revision, optional section, and short excerpt rather than duplicating whole plans.

## Operating topology

- One persistent Codex repository coordinator is a thin relay and monitor: it maintains portfolio orientation, carries user direction, and watches sequencing and material cross-workstream conflicts without owning product or technical decisions.
- One persistent Codex workstream orchestrator owns each durable outcome but normally delegates implementation to Codex workers in isolated worktrees.
- Independent Codex review tasks are delegated through native task channels and publish exact-head evidence through Field Report.
- Field Report is the durable control plane; sleeping agent sessions never own the only copy of pending work or review evidence.
- Agent Fixes provides the linked issue list only.
- GitHub remains authoritative for pull-request state.

`fr context` infers the repository, workstream, branch, head, delivery artifact, next gate, and MRR state from the checkout. External Git worktrees, including Codex-managed worktrees outside the configured checkout path, resolve through their shared Git common directory. `fr coordinate` and `fr catchup` infer the repository when no ID is supplied and accept the configured ID or repository-directory name. `fr coordinate` runs an initial catch-up; later calls report changes since the durable repository cursor plus outcomes needing attention.

`fr assess` prepares a bounded, target-specific advisory brief for native Codex delegation; it does not send through AF and does not create MRR evidence. Gating review requires a separate role-specific delegation with truthful model/provider provenance. That reviewer uses `fr pass record` for one lane or `fr pass import` for a structured envelope. Review passes require a code anchor on the outcome—a branch, commit, or PR—so audit-only outcomes cannot accumulate code-readiness evidence.

`fr checkpoint` automatically records the current full commit and fills an unassigned branch when the checkout maps unambiguously to the workstream repository. It does not copy GitHub facts into canonical state, and a semantically identical checkpoint is skipped instead of adding timeline noise. Pass `--evidence false` only when the checkout must not contribute Git evidence.

`docs/fr-workflow.md` is the canonical opt-in orchestration contract. It is not copied into repository `AGENTS.md` files used by other developers. `fr coordinate`, `fr onboard`, and `fr workflow` derive a role projection containing the shared contract plus only the armed session's role section.

Review passes record reviewer, model, verdict, exact head SHA, readiness/risk judgments, findings, and unresolved considerations. When the branch advances, prior passes remain in history but are counted as superseded rather than current-head evidence.

Fable envelopes must explicitly record `review_complete: true`, `independent: true`, the canonical Fable model, `provider: "anthropic"`, `route: "claude-aws"`, and the SHA-256 digest of persisted raw evidence. A provider label alone is insufficient. This deliberately invalidates legacy Fable evidence lacking route/digest provenance; rerun it on the exact head.

For code outcomes, completion is guarded by an exact-head review policy. The default `full` policy requires independent `deep-code-review` and `structural-challenge` roles. AON and Arrusted require a full exact-head fleet containing at least two distinct Sol reviewers and one Fable reviewer verified through `claude-aws`; another Anthropic model is not a substitute. Only `GO` satisfies readiness.

Every commit has a separate local staged-tree gate. Two distinct Sol reviewer tasks inspect the exact `{base HEAD, staged tree}` candidate and publish their own records. Agents commit through `fr commit`; changing the index or base invalidates the panel. Final fleet MRR, including verified Fable, is still required before declaring a PR ready.

Remote publication before MRR is draft-only review infrastructure. `fr release-check <id>` compares the checkout, live origin branch, GitHub PR, and MRR-reviewed head and exits nonzero unless the PR may be marked ready. It does not authorize merge.

`fr policy --user-authorized` supports `single-independent`, `delta`, or `none` exceptions with an explicit reason. Delta passes record `--scope delta --base-head <full-sha>`. Only direct user invocation may change policy; agents can recommend an exception but cannot select it. Field Report rejects the first transition to `complete` while the selected policy is unsatisfied. Non-code outcomes without a branch, PR, or commits are exempt.

## Start

Requires Node.js 20+, `af`, and `gh` on `PATH`.

```bash
npm run dev
```

Open <http://127.0.0.1:4177>. The server performs one collection at startup. After that, use **Refresh sources** in the dashboard or run:

```bash
npm run refresh
```

No background timer is used.

Select an outcome and expand **Orchestrator binding** to update its persistent Codex task assignment. Executors and reviewers are delegated native Codex tasks recorded on semantic events rather than permanent workstream roles.

Each workstream displays two reviewer-owned, evidence-backed percentages:

- **Merge readiness:** probability that the branch can merge without material changes beyond normal review and release gates. This is not merge authorization.
- **Structural rebuild risk:** probability that architectural or contract rot makes a bounded rebuild safer or cheaper than continuing to patch the current branch.

Select one or more outcomes and use **Prepare review brief** when fresh advisory judgment is needed. The brief is copied for delivery through a native Codex task channel and is explicitly non-gating. Start a separate role-specific review task before recording any MRR pass.

The dashboard is attention-first: each row reports whether the outcome needs the user, its current gate, delivery artifact, and freshness. The deep dive keeps the 2–3 line situation, remaining milestones, exact-SHA review ledger, governing git references, linked AF issues, and semantic timeline.

## Configure the pilot

1. `config/projects.json` contains the real AON and Arrusted repositories; `config/sessions.json` maps exact Codex task UUIDs to readable aliases.
2. Edit the files under `workstreams/`; each file represents a durable outcome that may span several PRs and agent sessions.
3. Keep each summary to two or three lines: intended outcome, current position, and next action or blocker.
4. Keep each checklist item commit-sized or independently verifiable. Group related chunks into a review-worthy PR rather than defaulting to micro-PRs.
5. Add associated PR numbers to `prs`, for example:

```json
"prs": [{ "number": 254, "chunks": ["client-migration", "failure-ux"] }]
```

## Questions and decisions

Use `fr ask` and `fr decide` for durable uncertainty. Native task messages may notify or wake the orchestrator, but message text is not parsed into canonical Field Report state.

## Storage and history

- `workstreams/*.json` is the curated, one-file-per-workstream arc.
- `data/current.json` is a generated local projection and is replaced atomically.
- `snapshots/*.json` is optional generated local history.
- Generated projections are ignored by Git; canonical workstreams and semantic event ledgers provide durable history.
- `generatedAt` records source refresh time; each workstream's `updatedAt` records its last meaningful narrative update.

## Authority boundaries

- Field Report: curated outcome, gate, next action, questions, decisions, milestones, and completed exact-SHA review passes.
- Native Codex task channels: delegation, follow-up, waiting, waking, and message transport.
- AF: linked issues only.
- Git: implementation plus authoritative plans and contracts at a named revision.
- GitHub: pull-request head, checks, review state, and merge state.

The deep-dive timeline is derived only from semantic Field Report events and is capped to the 20 most recent entries. Ordinary native task messages and child-agent transcripts stay out of the portfolio.
