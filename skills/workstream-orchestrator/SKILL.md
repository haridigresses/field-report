---
name: workstream-orchestrator
description: Orchestrate one durable Field Report outcome through native Codex delegation, independent panels, and exact-SHA reconciliation. Use when a persistent Codex workstream owner should plan, delegate, wake agents, review evidence, and report status without routinely editing implementation files.
---

# Workstream Orchestrator

Run `fr onboard <workstream-id> --role workstream-orchestrator` at session start. It must return the Shared and Workstream orchestrator sections of the canonical workflow contract; read them before any workstream action. If the contract is unavailable, do not mutate workstream state. Run `fr workflow` again after compaction.

Own one approved outcome, its mechanism, slices, workers, review reconciliation, exact-head MRR, and delivery. Normally delegate implementation to Codex workers in isolated worktrees. Give each worker a bounded brief with outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and completion envelope.

Use the routing and authority boundaries in the projected canonical contract; do not create a parallel skill-level policy. Keep routine implementation coordination inside the workstream.

Use independent native Codex review tasks in proportion to risk and persist only completed exact-head evidence. If using Fable, first read `references/fable-review.md`. Match reasoning effort to the decision; use fresh-context structural challenge for premise-sensitive work rather than a permanent co-reviewer.

Before every commit, including every patch commit, freeze the index and obtain fresh local deep-code and structural-challenge reviews of the exact base HEAD and staged tree from two distinct Sol tasks. Each reviewer records its own native identity and Sol model with `fr commit-review record`; commit only through `fr commit`. Any staged or base change requires a new panel. This local gate does not replace final fleet MRR.

For AON and Arrusted full MRR, staff multiple distinct Sol reviewers plus at least one Fable reviewer through verified `claude-aws`, all on the exact final SHA. Another Anthropic model or an unverified Fable invocation does not satisfy the fleet.

Direct user instructions to a workstream are controlling for that workstream. Repository-coordinator portfolio authority does not override them unless the user explicitly delegates the decision.

Code completion requires the selected exact-head MRR policy; earlier-head or partial review evidence does not transfer automatically.

Remote publication before MRR is draft-only review infrastructure. Push the candidate when CI or review needs it, but do not create, reopen, convert, or describe a PR as non-draft or ready until `fr release-check` succeeds against the live checkout, origin, GitHub PR, and reviewed head. A substantive push invalidates the prior release check.

Use `fr hold --reason ...` for required evidence outside MRR. Do not encode a publication blocker only in prose. The release PR must be linked to exactly one workstream.
