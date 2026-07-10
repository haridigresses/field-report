# Workstream Control

A local portfolio field report for Codex executors, Fable/Claude agents, Agent Fixes coordination, and GitHub pull requests.

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
