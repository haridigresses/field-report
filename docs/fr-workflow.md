# Field Report Workflow Contract

This contract applies only to sessions explicitly armed through `fr`. Repository `AGENTS.md` files remain authoritative for engineering and contributor rules; this contract adds personal orchestration behavior without changing the experience of other developers.

## Shared contract

- Treat Field Report as durable outcome, assignment, and review state. Native Codex task channels carry live execution and messaging; AF supplies linked issues only. Do not make a live transcript the only source of a decision, blocker, or review verdict.
- Keep workstreams outcome-sized and milestones commit-sized or independently verifiable. Avoid micro-PRs and unrelated scope bundles.
- Bind every implementation and review claim to an exact Codex task UUID, repository, worktree, branch, and head SHA. Field Report session aliases are human-readable labels; the UUID remains authority.
- A substantive commit invalidates earlier merge-ready verdicts until a fresh or explicit delta review covers the new head.
- A code workstream or PR-level delivery chunk is not done merely because implementation and repository checks pass. The default `full` policy requires independent `deep-code-review` and `structural-challenge` roles on the exact head. Reviewer implementation is interchangeable; reconcile both roles, record both with `fr pass record --role ...`, and confirm `fr mrr` reports READY.
- Only the user or repository coordinator may select a reasoned `single-independent`, `delta`, or `none` exception with `fr policy`. A workstream orchestrator must not weaken its own gate. Delta evidence records both the current head and exact base head.
- Reconcile reviewer disagreement against code, tests, and contracts; never decide by vote.
- Preserve user merge authority. Readiness, CI, agents, and workflow state do not authorize merge unless the user explicitly says so.
- Record only semantic gates in Field Report: scope decisions, milestone completion, commits, PRs, blockers, questions, review passes, and reconciliation. Keep ordinary tool activity in child transcripts.
- Start orientation with `fr context`; it resolves the current repository, checkout, workstream, delivery artifact, next gate, and MRR result without requiring separate status/list/show calls. Use `fr catchup` only for the repository change and attention queues.
- Let `fr checkpoint` attach deterministic checkout branch/head evidence. Do not manually repeat `fr link commit` for the same head, and do not create a checkpoint when canonical semantic state is unchanged.
- Pause for product or scope decisions. Do not silently widen the intended outcome or add compatibility, abstraction, or process that is not necessary.
- Before accepting an implementation mechanism, restate the user outcome and challenge the proposal: Does this need to exist? Is there a simpler path? Would it create noise, duplicate authority, or ongoing coordination cost? Prefer the smallest approach that reliably solves the outcome, and say so when the proposed mechanism is not that approach.

## Repository coordinator

- Stay long-running and repository-scoped. Own portfolio ordering, workstream creation, cross-workstream conflicts, shared contract decisions, and Field Report hygiene.
- Delegate each active outcome to one persistent workstream orchestrator. Do not become its routine implementer or duplicate reviewer.
- During normal operation, do not approve compile checkpoints, direct commit splits, manage individual bot findings, supervise workers, or run intra-workstream review panels. Those belong to the workstream orchestrator.
- Delegate, wake, and steer orchestrators through Codex-native task channels. Assign their exact task UUIDs in Field Report and register readable aliases with `fr session alias`; do not duplicate live messaging through AF.
- Run `fr catchup` when starting, resuming, before battlefield reporting, and before sequencing or merge-order decisions. Routine orientation is the coordinator's responsibility; do not require busy workstreams to narrate state already recorded in Field Report.
- Keep the repository battlefield current: active outcomes, blockers, open questions, PRs, merge order, and structural risks.
- Intervene when workstreams collide, stall, drift in scope, or depend on inconsistent contracts. Otherwise let the workstream orchestrator reconcile its own workers and reviewers.
- Recovery intervention is a bounded exception, not a standing role or Field Report status. State the unsafe drift or architectural risk that triggered it, define the condition for returning ownership, intervene only until that condition is met, and hand control back promptly.
- Own outcome necessity, portfolio priority, sequencing, and duplicated or shared authority. The workstream orchestrator owns mechanism and slice necessity within the approved outcome; reviewers challenge necessity and supply evidence rather than deciding product priority.
- Routine builds, commits, CI progress, individual bot findings, worker updates, and panel activity are not coordinator check-ins. A workstream pushes only blockers, material scope changes, shared-contract conflicts, sequencing changes, or readiness, parking, and completion events.

## Workstream orchestrator

- Own one durable outcome and normally do not edit implementation files. Delegate implementation to Codex workers in isolated worktrees.
- Write a bounded brief for every worker: outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and required completion envelope.
- Staff independent review roles in proportion to risk. Fable through `claude-aws` may serve as one reviewer, but no vendor or model is universally primary.
- Require every worker to return: exact SHA, diff summary, checks run and results, skipped checks, scope deviations, unresolved questions, and simplification or structural concerns.
- Verify worker claims before publishing them. Confirm the actual diff, head, push, checks, and review scope.
- Reconcile all findings and publish one concise workstream status. Escalate only unresolved product direction, material scope expansion, or genuine architectural alternatives.
- Keep implementation chatter out of Field Report. Publish the current phase, next gate, blocker/question state, delivery evidence, and exact-SHA review ledger.
- Push a native Codex task message to the repository coordinator only when coordinator awareness or action is genuinely needed: user/product decision, cross-workstream collision, shared-contract change, material schedule blocker, merge-order change, merge readiness, structural-risk change, or parking/completion. Do not send routine checkpoint mail.
- Treat delegated review as incomplete until an explicit `review_complete: true` result is reconciled and recorded at the exact 40-character SHA. Use `fr pass record` for one lane or one `fr pass import` envelope for multiple completed lanes.
- Do not mark a PR-level chunk or code workstream complete until its selected review policy is satisfied, no required pass is NO-GO, and no required current-head findings remain unresolved. Under the default `full` policy, both reviewer roles must cover the current head. Locally green, CI green, or one 5/5 review is insufficient.
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
