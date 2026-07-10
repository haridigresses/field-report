# Field Report

A local portfolio field report for Codex executors, Fable/Claude agents, Agent Fixes coordination, and GitHub pull requests.

Agents and users interact through the `fr` CLI. AF subject syntax remains an internal compatibility layer; normal instructions should be natural language such as “track this in Field Report,” “record this decision,” or “reconcile this workstream.”

## Install

```bash
node scripts/install.mjs
```

This installs `fr` in `~/.local/bin`, the shared `field-report` skill for Codex and Claude, Claude's `/fr` command, and quiet Claude session-start/stop hooks. Hooks automatically arm only when the repository and branch match exactly; otherwise they do nothing.

Common operations:

```bash
fr create --repo aon --title "Document-zone cutover" --outcome "Move document writes to the canonical audit boundary" --orchestrator refrev
fr onboard aon-document-zone-cutover
fr ask "Does attachment history belong in this slice?"
fr checkpoint --summary "Implementation complete; exact-SHA review is next" --status active --gate "Exact-SHA review"
fr reconcile --data '{"summary":"...","chunks":[...]}'
fr assess
fr watch start
fr watch stop
```

Field Report writes canonical updates immediately and refreshes external GitHub/AF facts in a debounced background pass.

## Operating topology

- One manually launched `claude-aws` coordinator per repository.
- One manually launched `claude-aws` Fable orchestrator/reviewer per workstream.
- One Codex executor task per workstream.
- Agent Fixes provides names, inbox coordination, issues, and session visibility.
- GitHub remains authoritative for pull-request state.

The dashboard does not launch Claude. Start each Fable agent with `claude-aws`, name/register it in Agent Fixes, and place that AF name in the corresponding workstream JSON file.

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

Select an outcome and expand **Agent sessions** to update its Fable workstream agent, reviewer, or Codex executor. Saving persists the values to the matching `workstreams/*.json` file, then refreshes collected state.

Each workstream displays two reviewer-owned, evidence-backed percentages:

- **Merge readiness:** probability that the branch can merge without material changes beyond normal review and release gates. This is not merge authorization.
- **Structural rebuild risk:** probability that architectural or contract rot makes a bounded rebuild safer or cheaper than continuing to patch the current branch.

Reviewers publish ratings through AF inbox using a leading subject such as `[RATING aon-pr-audit] merge=85 structural=15 head=59c89cd9` and put the evidence summary in the body. The collector accepts only an exact workstream ID. The card always shows both ratings; missing ratings display as unassessed rather than inventing confidence. When a linked GitHub PR advances beyond the assessed SHA, the rating is marked stale.

For a fuller judgment, select one or more outcomes and use **Request assessment**. The server sends the configured reviewer an evidence-backed rubric covering outcome confidence, merge readiness, structural rebuild risk, necessity, simpler paths, scope drift, contract integrity, evidence quality, plan contradictions, primary risk, and next gate. The request is recorded through AF and appears as pending until a newer assessment arrives.

The request names a separate **publication lane**: the repository coordinator's AF inbox, which the collector monitors. When the reviewer is also the coordinator, sending the response to their own AF name is intentional. Reviewers should not reroute responses to executors merely because those executors own the branch. Dashboard context is explicitly labeled as potentially stale and must be reconciled against current evidence before judgment.

The structured response subject is:

```text
[ASSESSMENT <workstream-id>] head=<sha> outcome_confidence=<0-100> merge_readiness=<0-100> structural_rebuild_risk=<0-100> necessity=<clear|challenged|unjustified> simpler_path=<none_found|candidate|recommended> scope_drift=<none|low|material> contract_integrity=<sound|at_risk|broken> evidence_quality=<strong|partial|weak> verdict=<GO|CONDITIONAL_GO|NO_GO>
```

Its body uses `primary_risk:`, `next_gate:`, and `rationale:` lines. Existing compact `[RATING ...]` messages remain supported.

The dashboard leads with one comparable row per durable outcome. Repository is an optional filter rather than the primary hierarchy. Each row reports phase, blockage, uncertainty, delivery artifact, confidence, and material risk. Selecting it opens the situation brief, milestone-to-PR delivery chain, reviewer evidence, AF issue count, and agent sessions.

## Configure the pilot

1. `config/projects.json` contains the real AON and Arrusted repositories and their repository coordinator AF names.
2. Edit the files under `workstreams/`; each file represents a durable outcome that may span several PRs and agent sessions.
3. Keep each summary to two or three lines: intended outcome, current position, and next action or blocker.
4. Keep each checklist item commit-sized or independently verifiable. Group related chunks into a review-worthy PR rather than defaulting to micro-PRs.
5. Add associated PR numbers to `prs`, for example:

```json
"prs": [{ "number": 254, "chunks": ["client-migration", "failure-ux"] }]
```

## Questions through AF

The collector recognizes messages that contain the workstream ID and use matching question IDs:

```text
[QUESTION aon-write-path Q1] Which compatibility boundary applies?
[ANSWER aon-write-path Q1] Preserve the old RPC through PR 254.
```

Questions may also be recorded directly in the workstream JSON file. An unanswered question appears as uncertainty in the portfolio and in the selected situation brief.

## Storage and history

- `workstreams/*.json` is the curated, one-file-per-workstream arc.
- `data/current.json` is the latest generated aggregate and is replaced atomically.
- `snapshots/YYYY-MM-DD-HASH.json` records materially distinct daily states. Repeated refreshes with no meaningful state change do not create duplicate snapshots.
- `generatedAt` records source refresh time; each workstream's `updatedAt` records its last meaningful narrative update.
- Active workstreams older than 12 hours receive a stale warning.

## Coordination protocol

Useful AF message subjects:

```text
[QUESTION <workstream-id> Q1] ...
[ANSWER <workstream-id> Q1] ...
[STATUS <workstream-id>] ...
[PR <workstream-id>] #254 opened
[REVIEW <workstream-id>] ...
[COMPLETE <workstream-id>] ...
```

The first pilot intentionally keeps narrative updates explicit. AF and GitHub are collected automatically; the 2–3 line arc and semantically sized checklist remain curated by the workstream orchestrator or Codex executor.

The deep-dive **Recent movement** timeline is derived from structured workstream messages and AF messages linked to the workstream's issue tree. It is append-only in source, capped to the 20 most recent material events in the UI, and intentionally excludes ordinary unlinked inbox chatter.
