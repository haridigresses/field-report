---
name: field-report
description: Maintain Field Report workstreams with the fr CLI. Use when the user says Field Report, fr, track this work, create a workstream, record a question or decision, reconcile a workstream, update the portfolio, request an assessment, checkpoint progress, or keep an orchestrator session synchronized with durable outcome state.
---

# Field Report

Use `fr` instead of editing Field Report JSON. The CLI writes through the local shared core and does not require the dashboard server. If the dashboard is offline, continue recording canonical state normally; linked AF issues, GitHub, and repository facts appear after the next source refresh.

## Start

Run `fr status`. If unarmed:

- Run `fr auto-onboard` when the current branch already belongs to a workstream.
- Run `fr coordinate <repo-id>` for a persistent repository coordinator.
- Run `fr catchup` whenever a repository coordinator resumes or needs a fresh battlefield view.
- Run `fr context` for one concise checkout-aware orientation before reaching for separate `status`, `list`, or `show` calls.
- Run `fr onboard <id> --role workstream-orchestrator|reviewer|executor` when the workstream ID is known.
- Run `fr create ...` when the user asks to track a new durable outcome.
- Register a short, globally unique name with `fr session alias <alias> [--id <codex-task-uuid>]`; use a repository prefix only for a real collision. Renaming preserves the previous alias as a fallback. Assign responsibility with `fr assign <workstream-id> --session <alias-or-uuid>`. When the Codex surface exposes task-title management, also rename that task to the same primary label. The Field Report alias is durable coordination state; the sidebar title is a best-effort UI mirror, and the task UUID remains identity.

After arming, speak normally with the user. Do not expose routing syntax unless debugging.
Treat the role-specific workflow contract printed by `fr` as canonical. Use `fr workflow` to print it again after compaction.

Use `fr watch --once` to identify outcomes that need a native Codex follow-up. Field Report does not run a background AF delivery loop.

## Record durable state

- Situation or gate changed: `fr checkpoint --summary "..." --status active --gate "..." --note "..."`
- Full consistency pass: `fr reconcile --data '<json patch>' --note "..."`
- Durable question: `fr ask "..."`
- Decision: `fr decide Q1 "..."`
- Execution evidence: `fr link issue <issue-id>` and `fr link commit <sha> --chunk <milestone-id>`.
- Governing git context: `fr reference --path <repo-relative-path> --kind plan|contract|decision|review --quote "<short exact excerpt>"`.
- Prepare fresh reviewer judgment with `fr assess <id>`, then send its bounded brief through the native Codex delegation or task-messaging tool. Do not use AF inbox as a fallback.
- Publish completed judgment: `fr pass record <id> --head <full-40-char-sha> --verdict <GO|CONDITIONAL_GO|NO_GO> --role deep-code-review|structural-challenge --model <model> [--reasoning high] --merge <0-100> --structural <0-100> ...`.
- Publish a complete structured panel in one operation: `fr pass import <id> --file <review-envelope.json>` (or `--data '<json>'`). Each pass is validated independently and incomplete passes are rejected.
- Verify the PR-level completion gate: `fr mrr [id]`. The default `full` policy requires current-head deep-code and structural-challenge passes. The user or repository coordinator may set a reasoned exception with `fr policy`; a workstream orchestrator may not downgrade its own gate.
- End of assignment: reconcile material changes, then `fr disarm`.

Use `fr show --json` before a broad reconciliation. Keep summaries to the outcome, current phase or gate, and next milestone or blocker. Keep milestones commit-sized or independently verifiable, not micro-task-sized.

Link only git documents that constrain scope, architecture, contracts, or review. Store a path, optional section anchor, and short exact excerpt; never copy the plan into Field Report. Git remains the source of truth.

## Update autonomously

Checkpoint at material gates: meaningful commit, push, PR creation, review verdict, blocker change, AF issue resolution, question resolution, or session end. `fr checkpoint` infers the current full commit and an unassigned matching branch; do not repeat that evidence with `fr link commit`. Identical checkpoints are skipped. Skip ordinary tool use and implementation chatter. When a Field Report nudge arrives, reconcile the delta against current evidence before publishing.

## Authority

- Orchestrators may update situation, status, milestones, PR associations, questions, and next gate.
- Reviewers own evidence-backed outcome confidence, merge readiness, simplification, structural rebuild risk, and challenges to necessity. Workstream orchestrators decide mechanism and slice necessity within the approved outcome; repository coordinators decide outcome necessity and portfolio priority.
- Codex-native task channels transport delegation and review requests; only a completed `fr pass record` entry is dashboard review authority. AF is reserved for its issue list.
- Never treat locally green, CI green, or one reviewer as PR-level completion. `fr mrr` must report READY before a code workstream is marked complete.
- Never silently change the durable outcome or accept material scope expansion. Record it as a question or proposal for the user.
- Preserve history; correct stale state with a new checkpoint rather than rewriting past events.
- Challenge implementation mechanisms before executing them: restate the user outcome, test necessity, seek the simpler path, and reject noisy or duplicative coordination. Workstreams push consequential exceptions; repository coordinators pull routine orientation with `fr catchup`.

Run `fr help` for command syntax.
