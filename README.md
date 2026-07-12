# Field Report

A local portfolio field report for Codex executors, Fable/Claude agents, Agent Fixes coordination, and GitHub pull requests.

Agents and users interact through the `fr` CLI. Field Report owns curated outcome state and the exact-SHA review ledger; AF transports requests and owns issues, sessions, lineage, and messaging.

## Install

```bash
node scripts/install.mjs
```

This installs `fr` in `~/.local/bin`, the shared Field Report and coordination-role skills for Codex and Claude, Claude's `/fr` command, and quiet Claude session-start/stop hooks. Hooks automatically arm only when the repository and branch match exactly; otherwise they do nothing.

Common operations:

```bash
fr create --repo aon --title "Document-zone cutover" --outcome "Move document writes to the canonical audit boundary" --orchestrator refrev
fr coordinate aon
fr catchup
fr onboard aon-document-zone-cutover --role workstream-orchestrator
fr workflow
fr ask "Does attachment history belong in this slice?"
fr checkpoint --summary "Implementation complete; exact-SHA review is next" --status active --gate "Exact-SHA review"
fr reconcile --data '{"summary":"...","chunks":[...]}'
fr assess
fr delegate review aon-document-zone-cutover
fr pass record aon-document-zone-cutover --head 4ad570c2e81ac141fa18cc0893465264b533f637 --verdict CONDITIONAL_GO --reviewer codex-xhigh --model gpt-5.6 --merge 82 --structural 8 --summary "Contracts hold; one evidence gap remains."
fr link issue ad.41
fr link commit 4ad570c2 --chunk kernel-timeout
fr reference --path docs/import-principles.md --kind contract --quote "Ambiguity and contradiction surface as reviewable, actionable issues at compile time."
fr watch start
fr watch stop
```

Field Report writes canonical updates immediately and refreshes external GitHub/AF facts in a debounced background pass.

AF issues remain the execution ledger; Field Report links issue trees to durable outcomes and milestones. Commit SHAs are delivery evidence, not narrative status. Git plans and contracts remain authoritative in their repositories: Field Report stores only pointed references (path, revision, optional section, and a short exact excerpt) when they materially constrain a workstream. Avoid attaching general documentation or duplicating entire plans.

## Operating topology

- One persistent Codex repository coordinator owns portfolio orientation, workstream creation, sequencing, and cross-workstream conflicts.
- One persistent Codex workstream orchestrator owns each durable outcome but normally delegates implementation to Codex workers in isolated worktrees.
- Claude/Fable is an on-demand primary independent reviewer or architecture challenger, invoked through `fr delegate review` and the required `claude-aws` Mantle path.
- Field Report is the durable control plane; sleeping agent sessions never own the only copy of pending work or review evidence.
- Agent Fixes provides names, inbox coordination, issues, session visibility, and execution provenance.
- GitHub remains authoritative for pull-request state.

Repository coordinators own routine orientation. `fr coordinate` runs an initial catch-up; later `fr catchup` calls report semantic and delivery changes since the durable repository cursor plus all outcomes currently needing attention. Workstream orchestrators keep Field Report current and push AF messages only for consequential exceptions that require coordinator awareness or action.

`fr assess` and `fr delegate review` both send a bounded review request to the workstream orchestrator. The orchestrator may delegate to Fable through `claude-aws` or to Codex panels, but only an explicit `fr pass record` at a full 40-character SHA counts as completed review evidence.

`docs/fr-workflow.md` is the canonical opt-in orchestration contract. It is not copied into repository `AGENTS.md` files used by other developers. `fr coordinate`, `fr onboard`, and `fr workflow` load the shared contract plus only the armed session's role section.

Review passes record reviewer, model, verdict, exact head SHA, readiness/risk judgments, findings, and unresolved considerations. When the branch advances, prior passes remain in history but are counted as superseded rather than current-head evidence.

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

Select an outcome and expand **Orchestrator binding** to update its persistent AF session. Executors and reviewers are delegated runs recorded on semantic events rather than permanent workstream roles.

Each workstream displays two reviewer-owned, evidence-backed percentages:

- **Merge readiness:** probability that the branch can merge without material changes beyond normal review and release gates. This is not merge authorization.
- **Structural rebuild risk:** probability that architectural or contract rot makes a bounded rebuild safer or cheaper than continuing to patch the current branch.

Select one or more outcomes and use **Request assessment** when fresh judgment is needed. The request is delivered through AF to the workstream orchestrator and recorded as a semantic request event. The reviewer publishes directly with `fr pass record`; AF subjects never mutate outcome status, questions, or assessment fields.

The dashboard is attention-first: each row reports whether the outcome needs the user, its current gate, delivery artifact, and freshness. The deep dive keeps the 2–3 line situation, remaining milestones, exact-SHA review ledger, governing git references, linked AF issues, and semantic timeline.

## Configure the pilot

1. `config/projects.json` contains the real AON and Arrusted repositories and their repository coordinator AF names.
2. Edit the files under `workstreams/`; each file represents a durable outcome that may span several PRs and agent sessions.
3. Keep each summary to two or three lines: intended outcome, current position, and next action or blocker.
4. Keep each checklist item commit-sized or independently verifiable. Group related chunks into a review-worthy PR rather than defaulting to micro-PRs.
5. Add associated PR numbers to `prs`, for example:

```json
"prs": [{ "number": 254, "chunks": ["client-migration", "failure-ux"] }]
```

## Questions and decisions

Use `fr ask` and `fr decide` for durable uncertainty. AF can notify or wake the orchestrator, but inbox subject lines are not parsed into canonical Field Report state.

## Storage and history

- `workstreams/*.json` is the curated, one-file-per-workstream arc.
- `data/current.json` is a generated local projection and is replaced atomically.
- `snapshots/*.json` is optional generated local history.
- Generated projections are ignored by Git; canonical workstreams and semantic event ledgers provide durable history.
- `generatedAt` records source refresh time; each workstream's `updatedAt` records its last meaningful narrative update.

## Authority boundaries

- Field Report: curated outcome, gate, next action, questions, decisions, milestones, and completed exact-SHA review passes.
- AF: issues, sessions, delegation, lineage, waking, and message transport.
- Git: implementation plus authoritative plans and contracts at a named revision.
- GitHub: pull-request head, checks, review state, and merge state.

The deep-dive timeline is derived only from semantic Field Report events and is capped to the 20 most recent entries. Ordinary AF activity and child-agent transcripts stay out of the portfolio.
