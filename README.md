# Field Report

A local portfolio field report for Codex task coordination, linked Agent Fixes issues, and GitHub pull requests.

Agents and users interact through the `fr` CLI. Field Report owns curated outcome state, readable aliases for exact Codex task UUIDs, and the exact-SHA review ledger. Native Codex task channels carry delegation and messaging; AF supplies only the issue list.

The CLI is local-first and does not require the dashboard server. Canonical workstream updates, event appends, questions, decisions, review passes, policies, and assessment requests go through the same filesystem-backed core used by the HTTP server. A short cross-process lock prevents agents from overwriting one another. Run the server only to view or operate the browser dashboard; use **Refresh sources** when you want it to collect the latest canonical, AF, GitHub, and repository state.

Field Report stores durable Codex task UUIDs separately from their human-readable aliases. Use `fr session alias <alias> [--id <uuid>]` to name a task and `fr assign <workstream-id> --session <alias-or-uuid>` to assign it. Native Codex delegation and messaging carry live coordination; AF is collected only as the linked issue ledger.

## Install

```bash
node scripts/install.mjs
```

This installs `fr` in `~/.local/bin`, the shared Field Report and coordination-role skills for Codex and Claude, Claude's `/fr` command, and quiet Claude session-start/stop hooks. Hooks automatically arm only when the repository and branch match exactly; otherwise they do nothing.

Common operations:

```bash
fr session alias aon-document-zone --id 019f0000-0000-7000-8000-000000000001
fr create --repo aon --title "Document-zone cutover" --outcome "Move document writes to the canonical audit boundary" --orchestrator 019f0000-0000-7000-8000-000000000001
fr assign aon-document-zone-cutover --session aon-document-zone
fr coordinate aon
fr context
fr catchup
fr mrr aon-document-zone-cutover
fr policy aon-document-zone-cutover --mode full
fr onboard aon-document-zone-cutover --role workstream-orchestrator
fr workflow
fr ask "Does attachment history belong in this slice?"
fr checkpoint --summary "Implementation complete; exact-SHA review is next" --status active --gate "Exact-SHA review"
fr reconcile --data '{"summary":"...","chunks":[...]}'
fr assess
fr pass record aon-document-zone-cutover --head 4ad570c2e81ac141fa18cc0893465264b533f637 --verdict CONDITIONAL_GO --role deep-code-review --reviewer codex-sol-high --model gpt-5.6-sol --reasoning high --merge 82 --structural 8 --summary "Contracts hold; one evidence gap remains."
fr pass import aon-document-zone-cutover --file /tmp/review-envelope.json
fr link issue ad.41
fr link commit 4ad570c2 --chunk kernel-timeout
fr reference --path docs/import-principles.md --kind contract --quote "Ambiguity and contradiction surface as reviewable, actionable issues at compile time."
fr watch --once
```

Field Report writes canonical updates immediately. Dashboard-originated writes trigger a debounced external refresh; CLI writes remain local and are incorporated on the next manual source refresh.

CLI updates do not automatically launch the dashboard or collect external sources. This keeps agent writes available when the UI is offline. The next dashboard refresh incorporates them.

AF remains the linked issue ledger; Field Report links issue trees to durable outcomes and milestones. Commit SHAs are delivery evidence, not narrative status. Git plans and contracts remain authoritative in their repositories: Field Report stores only pointed references (path, revision, optional section, and a short exact excerpt) when they materially constrain a workstream. Avoid attaching general documentation or duplicating entire plans.

## Operating topology

- One persistent Codex repository coordinator owns portfolio orientation, workstream creation, sequencing, and cross-workstream conflicts.
- One persistent Codex workstream orchestrator owns each durable outcome but normally delegates implementation to Codex workers in isolated worktrees.
- Independent Codex review tasks are delegated through native task channels and publish exact-head evidence through Field Report.
- Field Report is the durable control plane; sleeping agent sessions never own the only copy of pending work or review evidence.
- Agent Fixes provides the linked issue list only.
- GitHub remains authoritative for pull-request state.

Repository coordinators own routine orientation. `fr context` infers the repository, workstream, branch, head, delivery artifact, next gate, and MRR state from the checkout in one concise view. External Git worktrees, including Codex-managed worktrees outside the configured checkout path, resolve through their shared Git common directory. `fr coordinate` and `fr catchup` also infer the repository when no ID is supplied and accept the configured ID or repository-directory name. `fr coordinate` runs an initial catch-up; later `fr catchup` calls report semantic and delivery changes since the durable repository cursor plus all outcomes currently needing attention. Workstream orchestrators keep Field Report current and send consequential exceptions through native Codex task messaging.

`fr assess` prepares a bounded, target-specific review brief for native Codex delegation; it does not send through AF. Only an explicit exact-head review pass counts as completed evidence. Use `fr pass record` for one lane or `fr pass import` to validate and record all lanes from one structured JSON envelope. Review passes require a code anchor on the outcome—a branch, commit, or PR—so audit-only outcomes cannot accumulate code-readiness evidence.

`fr checkpoint` automatically records the current full commit and fills an unassigned branch when the checkout maps unambiguously to the workstream repository. It does not copy GitHub facts into canonical state, and a semantically identical checkpoint is skipped instead of adding timeline noise. Pass `--evidence false` only when the checkout must not contribute Git evidence.

`docs/fr-workflow.md` is the canonical opt-in orchestration contract. It is not copied into repository `AGENTS.md` files used by other developers. `fr coordinate`, `fr onboard`, and `fr workflow` load the shared contract plus only the armed session's role section.

Review passes record reviewer, model, verdict, exact head SHA, readiness/risk judgments, findings, and unresolved considerations. When the branch advances, prior passes remain in history but are counted as superseded rather than current-head evidence.

For code outcomes, completion is guarded by an exact-head review policy. The default `full` policy requires independent `deep-code-review` and `structural-challenge` roles; the durable contract is the role, not the vendor or model. Existing passes retain backward-compatible role inference; new passes should record `--role` explicitly. `fr mrr <id>` reports the policy, missing role, or READY.

The user or repository coordinator may choose `single-independent`, `delta`, or `none` with `fr policy`, but every non-full policy requires an explicit reason. Delta passes must record `--scope delta --base-head <full-sha>`. Workstream orchestrators cannot silently weaken their own completion gate. Field Report rejects the first transition to `complete` while the selected policy is unsatisfied. Non-code outcomes without a branch, PR, or commits are exempt.

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

Select one or more outcomes and use **Prepare review brief** when fresh judgment is needed. The brief is copied for delivery through a native Codex task channel. The reviewer publishes directly with `fr pass record`.

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
