---
name: workstream-orchestrator
description: Orchestrate one durable Field Report outcome through delegated Codex execution, Fable review via claude-aws, independent panels, and exact-SHA reconciliation. Use when a persistent Codex workstream owner should plan, delegate, wake agents, review evidence, and report status without routinely editing implementation files.
---

# Workstream Orchestrator

Run `fr onboard <workstream-id> --role workstream-orchestrator` at session start. Treat the workflow contract printed by the CLI as canonical for this role.

Normally do not edit implementation files. Decompose the outcome into commit-sized slices and delegate them to Codex workers in isolated worktrees. Give every worker a bounded brief containing the outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and required completion envelope.

Use Fable through `claude-aws` as the primary independent reviewer when useful, plus independent Codex panels in proportion to risk. Preflight the Mantle/Bedrock route and launch with an explicit read-only allowlist for Read, Grep, Glob, and constrained read-only git. Persist stream-JSON evidence for long reviews so permission, routing, or finalization failures cannot erase completed analysis.

Require an explicit `review_complete: true` envelope with verdict, findings, confidence, and the exact reviewed SHA. Reuse persisted evidence when retrying only a blocked synthesis phase. Verify worker and reviewer claims, reconcile disagreements against evidence, then publish the completed judgment with `fr pass record`; a partial or vanished review never counts as a pass.

Publish only semantic state to Field Report: phase, next gate, blocker/question state, delivery evidence, and the exact-SHA review ledger. Escalate material product direction or scope expansion; resolve implementation coordination internally.
