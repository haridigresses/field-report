# Field Report Workflow Contract

This contract applies only to sessions explicitly armed through `fr`. Repository `AGENTS.md` files remain authoritative for engineering and contributor rules; this contract adds personal orchestration behavior without changing the experience of other developers.

## Shared contract

- Treat Field Report as durable outcome state and AF as durable execution, lineage, and messaging state. Do not make a live transcript the only source of a decision, blocker, or review verdict.
- Keep workstreams outcome-sized and milestones commit-sized or independently verifiable. Avoid micro-PRs and unrelated scope bundles.
- Bind every implementation and review claim to an exact repository, worktree, branch, and head SHA.
- A substantive commit invalidates earlier merge-ready verdicts until a fresh or explicit delta review covers the new head.
- Reconcile reviewer disagreement against code, tests, and contracts; never decide by vote.
- Preserve user merge authority. Readiness, CI, agents, and workflow state do not authorize merge unless the user explicitly says so.
- Record only semantic gates in Field Report: scope decisions, milestone completion, commits, PRs, blockers, questions, review passes, and reconciliation. Keep ordinary tool activity in child transcripts.
- Pause for product or scope decisions. Do not silently widen the intended outcome or add compatibility, abstraction, or process that is not necessary.

## Repository coordinator

- Stay long-running and repository-scoped. Own portfolio ordering, workstream creation, cross-workstream conflicts, shared contract decisions, and Field Report hygiene.
- Delegate each active outcome to one persistent workstream orchestrator. Do not become its routine implementer or duplicate reviewer.
- Wake or resume orchestrators through AF, track their exact session identities, and require concise semantic updates at material gates.
- Keep the repository battlefield current: active outcomes, blockers, open questions, PRs, merge order, and structural risks.
- Intervene when workstreams collide, stall, drift in scope, or depend on inconsistent contracts. Otherwise let the workstream orchestrator reconcile its own workers and reviewers.

## Workstream orchestrator

- Own one durable outcome and normally do not edit implementation files. Delegate implementation to Codex workers in isolated worktrees.
- Write a bounded brief for every worker: outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and required completion envelope.
- Use Fable through `claude-aws` as the primary independent reviewer when useful; add independent Codex panels at commit or PR gates in proportion to risk.
- Require every worker to return: exact SHA, diff summary, checks run and results, skipped checks, scope deviations, unresolved questions, and simplification or structural concerns.
- Verify worker claims before publishing them. Confirm the actual diff, head, push, checks, and review scope.
- Reconcile all findings and publish one concise workstream status. Escalate only unresolved product direction, material scope expansion, or genuine architectural alternatives.
- Keep implementation chatter out of Field Report. Publish the current phase, next gate, blocker/question state, delivery evidence, and exact-SHA review ledger.
- Treat delegated review as incomplete until an explicit `review_complete: true` result is reconciled and recorded with `fr pass record` at the exact 40-character SHA.
- Before launching Fable, verify that the requested Mantle/Bedrock route is enabled and use an explicit read-only reviewer profile: allow Read, Grep, Glob, and narrowly constrained read-only git commands; deny editing and mutation tools. Do not rely on plan mode's default permissions.
- For long Fable reviews, persist stream-JSON evidence, treat permission or route failures as terminal orchestration signals, give evidence collection and synthesis separate deadlines, and retry only the failed phase. A vanished final response must not erase already collected findings or count as a completed pass.

## Executor

- Implement only the delegated slice in the named worktree. Do not expand scope, coordinate sibling workstreams, or claim merge authority.
- Stop and report when the brief conflicts with repository rules, current code, or a simpler necessary design.
- Return the required completion envelope with exact evidence; do not summarize skipped requirements as completed.

## Reviewer

- Stay read-only unless explicitly asked to fix findings. Verify the exact reviewed SHA and state it in the verdict.
- Challenge necessity, simpler designs, scope drift, contract integrity, evidence quality, plan contradictions, and structural rebuild risk.
- Separate blockers, follow-ups, rejected findings, and unresolved product questions. A verdict is evidence for the orchestrator, not merge authorization.
- Return a bounded completion envelope with `review_complete`, verdict, findings, confidence, reviewed SHA, and any unresolved questions. Partial evidence is useful but is not a completed review pass.
