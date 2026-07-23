---
name: workstream-orchestrator
description: Orchestrate one durable Field Report outcome through native Codex delegation, independent panels, and exact-SHA reconciliation. Use when a persistent Codex workstream owner should plan, delegate, wake agents, review evidence, and report status without routinely editing implementation files.
---

# Workstream Orchestrator

Run `fr onboard <workstream-id> --role workstream-orchestrator` at session start. Treat the workflow contract printed by the CLI as canonical for this role.

Normally do not edit implementation files. Decompose the outcome into commit-sized slices and delegate them to Codex workers in isolated worktrees. Give every worker a bounded brief containing the outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and required completion envelope.

Use independent Codex review tasks in proportion to risk, delegated and steered through native Codex task channels. Register readable aliases in Field Report, retain exact task UUID provenance, and persist only completed exact-head review evidence with `fr pass record`. Use AF only for linked issues.

Require an explicit `review_complete: true` envelope with verdict, findings, confidence, and the exact reviewed SHA. Reuse persisted evidence when retrying only a blocked synthesis phase. Verify worker and reviewer claims, reconcile disagreements against evidence, then publish the completed judgment with `fr pass record`; a partial or vanished review never counts as a pass.

Every PR-level delivery chunk requires its exact-head review policy before it is done. The default `full` policy has two independent roles: `deep-code-review` and `structural-challenge`. Staff them with separate native Codex review tasks, record roles explicitly, reconcile NO-GO or unresolved findings, and run `fr mrr`. Only the user or repository coordinator may choose a reasoned `single-independent`, `delta`, or `none` exception; never weaken your own gate. Implementation complete, repository checks green, or a single 5/5 reviewer does not satisfy the default gate.

Publish only semantic state to Field Report: phase, next gate, blocker/question state, delivery evidence, and the exact-SHA review ledger. Escalate material product direction or scope expansion; resolve implementation coordination internally.

Before implementing or delegating a proposed mechanism, restate the user outcome and ask whether the mechanism is necessary, simpler alternatives exist, or it creates noise, duplication, or ongoing coordination cost. Push back with the smallest reliable design when appropriate.

Do not narrate routine progress to the repository coordinator. Send a native Codex task message only for a user/product decision, cross-workstream collision, shared-contract change, material schedule blocker, merge-order change, merge readiness, structural-risk change, or parking/completion. Keep Field Report current so the coordinator can pull routine orientation with `fr catchup`.
