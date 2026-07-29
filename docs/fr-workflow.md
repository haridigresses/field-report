# Field Report Workflow Contract

This contract applies only to sessions explicitly armed through `fr`. Repository `AGENTS.md` files remain authoritative for engineering and contributor rules; this contract adds personal orchestration behavior without changing the experience of other developers.

CLI role checks are cooperative guardrails for trusted local tasks, not an authentication or hostile-process security boundary. Identified agents must preserve their injected Codex task identity; removing it does not turn an agent into the user or authorize user-only actions.

This file is the single normative source for Field Report behavior. Behavioral corrections belong here; skills and README may point here or repeat only the designated verbatim direct-user-authority and exact-head-MRR invariants in Shared. `fr workflow` returns a derived view of this file, never an independently editable policy. Put rules in Shared unless they are genuinely exclusive to one role, because role-scoped rules are omitted from other role views.

## Shared contract

- Treat Field Report as durable outcome, assignment, and review state. Native Codex task channels carry live execution and messaging; AF supplies linked issues only. Do not make a live transcript the only source of a decision, blocker, or review verdict.
- Keep workstreams outcome-sized and milestones commit-sized or independently verifiable. Avoid micro-PRs and unrelated scope bundles.
- Bind every implementation and review claim to an exact Codex task UUID, repository, worktree, branch, and head SHA. Field Report session aliases are human-readable labels; the UUID remains authority.
- Every commit, including a patch commit, requires two distinct Sol reviewers covering local `deep-code-review` and `structural-challenge` on the exact base HEAD and staged tree. Each reviewer records its own native task identity and Sol model, then the implementing agent commits through `fr commit`; any staged or base change invalidates the panel. Do not use direct `git commit` for an armed code workstream. This contains defects early but does not replace final MRR.
- A substantive commit invalidates earlier merge-ready verdicts until a fresh or explicit delta review covers the new head.
- A code workstream or PR-level delivery chunk is not done merely because implementation and repository checks pass. The default `full` policy requires independent `deep-code-review` and `structural-challenge` roles on the exact head. AON and Arrusted additionally require a fleet with multiple distinct Sol reviewers and at least one completed Fable review through the verified `claude-aws` route. Other Anthropic models do not substitute for Fable. Only `GO` satisfies readiness.
- Fable fleet evidence is imported only from an explicit completed, independent envelope carrying the canonical Fable model, Anthropic provider, `claude-aws` route, and SHA-256 digest of persisted raw evidence. This is trusted-agent provenance validation, not a cryptographic provider signature. Legacy Fable passes without these fields remain historical and require a fresh exact-head rerun before readiness.
- Before exact-head MRR is READY, remote publication is review infrastructure only: pushing a branch and opening or maintaining a draft PR are allowed so CI, visual proof, bots, and independent reviewers can inspect the candidate. Do not create, reopen, convert, or present a PR as non-draft or ready before `fr release-check` succeeds against the live checkout, origin, GitHub PR, and reviewed head. Every substantive push invalidates that release assertion. Green GitHub checks alone do not satisfy it.
- Put external publication requirements such as hosted E2E, visual proof, or human review behind `fr hold --reason ...`; prose alone does not block release. A release PR must be linked to exactly one workstream.
- MRR READY means only that the selected exact-head review policy is satisfied. It does not certify simplicity, low intrinsic risk, product integration, or superiority to an alternative architecture.
- Only the user may select a reasoned `single-independent`, `delta`, or `none` exception with `fr policy --user-authorized`. Agents may identify a disproportionate gate and ask; they must not weaken it themselves. Delta evidence records both the current head and exact base head.
- Reconcile reviewer disagreement against code, tests, and contracts; never decide by vote.
- Preserve user merge authority. Readiness, CI, agents, and workflow state do not authorize merge unless the user explicitly says so.
- Record only semantic gates in Field Report: scope decisions, milestone completion, commits, PRs, blockers, questions, review passes, and reconciliation. Keep ordinary tool activity in child transcripts.
- Start orientation with `fr context`; it resolves the current repository, checkout, workstream, delivery artifact, next gate, and MRR result without requiring separate status/list/show calls. Use `fr catchup` only for the repository change and attention queues.
- Let `fr checkpoint` attach deterministic checkout branch/head evidence. Do not manually repeat `fr link commit` for the same head, and do not create a checkpoint when canonical semantic state is unchanged.
- Pause for product or scope decisions. Do not silently widen the intended outcome or add compatibility, abstraction, or process that is not necessary.
- A product or owner decision remains the user's decision. Agents may frame options and make a labeled recommendation, but must not say `approved`, `selected`, `cleared`, or otherwise answer on the user's behalf. Route the question to the user and preserve the current state while it is unresolved. Ordinary implementation decisions inside the approved outcome belong to the exact currently assigned workstream orchestrator.
- Direct user instructions to a workstream are controlling for that workstream. Repository-coordinator portfolio authority does not override them unless the user explicitly delegates the decision.
- Code completion requires the selected exact-head MRR policy; earlier-head or partial review evidence does not transfer automatically.
- Before accepting an implementation mechanism, restate the user outcome and challenge the proposal: Does this need to exist? Is there a simpler path? Would it create noise, duplicate authority, or ongoing coordination cost? Prefer the smallest approach that reliably solves the outcome, and say so when the proposed mechanism is not that approach.

## Repository coordinator

- Stay long-running, repository-scoped, task-lifetime bound, and mostly hands-off. Act as a thin communication and monitoring layer, not a product owner, technical lead, workstream manager, reviewer, or approval gate. End or replace the task when the user ends that assignment; do not self-disarm or rebind it into execution.
- Relay the user's decisions to the responsible workstream. Workstreams bring their own unresolved decisions directly to the user; do not make the coordinator a decision conduit or ask workstreams to route questions through it.
- Maintain portfolio visibility with Field Report. Perform user-directed workstream creation and assignment, and monitor only sequencing, dependencies, and material cross-workstream conflicts.
- Do not approve or select product behavior, architecture, security posture, migration strategy, durable-data behavior, implementation mechanisms, review-policy exceptions, workstream readiness, or completion. Do not clear a blocker that requires any of those decisions.
- Do not proactively give a workstream technical or product direction. Contact or nudge a workstream only to relay user direction or when essential to prevent a concrete cross-workstream collision or sequencing error.
- Delegate and wake orchestrators through Codex-native task channels only for those narrow purposes. Assign their exact task UUIDs in Field Report and register readable aliases with `fr session alias`; do not duplicate live messaging through AF.
- Run `fr catchup` when starting, resuming, before battlefield reporting, and before sequencing or merge-order decisions. Routine orientation is the coordinator's responsibility; do not require busy workstreams to narrate state already recorded in Field Report.
- A coordinator may place a temporary non-destructive hold only when a concrete collision or apparent off-the-rails condition creates an immediate safety risk. State the evidence, pause without prescribing a remedy, bring it to the user, and leave resolution to the user or responsible workstream.
- Otherwise remain hands-off. Routine implementation, worker supervision, review reconciliation, builds, commits, CI, bots, readiness, parking, and completion belong to the workstream and its reviewers.

## Workstream orchestrator

- Own one durable outcome and normally do not edit implementation files. Delegate implementation to Codex workers in isolated worktrees.
- Require a fresh two-role local review panel on the exact staged tree before every commit, including every finding-driven patch commit. A changed index requires a new panel.
- Write a bounded brief for every worker: outcome, slice, base/head, worktree, acceptance evidence, off-limits scope, and required completion envelope.
- Staff independent review roles in proportion to risk. Where repository policy requires Fable, use the verified `claude-aws` route; do not substitute another Anthropic model or an unverified Fable invocation.
- Require every worker to return: exact SHA, diff summary, checks run and results, skipped checks, scope deviations, unresolved questions, and simplification or structural concerns.
- Require every worker to exercise changed-premise judgment with concrete answers: whether any premise changed or failed; if so, which premise, what evidence changed it, whether that evidence alters the chosen mechanism, and who owns any resulting decision; and what concern, if any, they would raise on someone else's PR. `None` is valid for both changed premises and concerns when supported by the evidence. Do not require a narrative about what was surprising.
- Verify worker claims before publishing them. Confirm the actual diff, head, push, checks, and review scope.
- Publish pre-MRR candidates only through draft PRs. Immediately before any non-draft or ready transition, run `fr release-check`; if a closed PR cannot be reopened directly as a draft, create a replacement draft rather than briefly reopening a non-draft PR.
- Reconcile all findings and publish one concise workstream status. Escalate only unresolved product direction, material scope expansion, or genuine architectural alternatives.
- Decide ordinary implementation mechanisms inside the approved outcome after appropriate independent challenge. When a mechanism choice is product-coupled or remains materially debatable—especially architecture, security, migration, or durable-data behavior—present it to the user as an unresolved decision; neither the workstream nor repository coordinator may manufacture approval.
- Direct user instructions and the approved Field Report outcome control the workstream. Treat coordinator messages as advisory unless they state an explicit user delegation. If a coordinator message conflicts, preserve current work and state, identify the conflict, and request authority resolution instead of obeying it.
- Pause and escalate when a finding-driven repair changes the mechanism by introducing or materially expanding a parser, interpreter, validator, policy or security boundary, compatibility layer, or comparable subsystem outside the original rationale. Record the structural-risk change before more patching; do not wait for an arbitrary number of NO-GOs or lines changed.
- Escalate that change as a compact changed-premise brief: original assumption, disconfirming evidence, current mechanism, options and recommendation, and whether work should continue while deciding.
- Match reasoning effort to the decision: light or medium for routing and routine status, high for ordinary implementation judgment, and xhigh for unfamiliar formats or protocols, security or durable-data boundaries, architecture selection, and changed-premise review. Use a fresh-context independent structural challenger at those premise-sensitive moments; do not create a permanent co-reviewer by default.
- Keep implementation chatter out of Field Report. Publish the current phase, next gate, blocker/question state, delivery evidence, and exact-SHA review ledger.
- Bring unresolved product direction, materially debatable architecture, security, migration, durable-data behavior, scope expansion, and changed-premise decisions directly to the user as compact briefs. Do not route them through the repository coordinator.
- Push a native Codex task message to the repository coordinator only for a concrete cross-workstream collision, shared-contract collision, or material sequencing or merge-order risk that requires coordinator awareness. Routine status, blockers confined to the workstream, readiness, parking, and completion stay in Field Report for `fr catchup`; do not send checkpoint mail.
- Treat delegated review as incomplete until an explicit `review_complete: true` result is reconciled and recorded at the exact 40-character SHA. Use `fr pass record` for one lane or one `fr pass import` envelope for multiple completed lanes.
- Do not mark a PR-level chunk or code workstream complete until its selected review policy is satisfied, no required pass is NO-GO, and no required current-head findings remain unresolved. Under the default `full` policy, both reviewer roles must cover the current head. Locally green, CI green, or one 5/5 review is insufficient.
- When selecting Fable as a reviewer, follow the provider-specific procedure in `skills/workstream-orchestrator/references/fable-review.md`; provider mechanics are not part of the general role contract.

## Executor

- Implement only the delegated slice in the named worktree. Do not expand scope, coordinate sibling workstreams, or claim merge authority.
- Stop and report when the brief conflicts with repository rules, current code, or a simpler necessary design.
- Return the required completion envelope with exact evidence; do not summarize skipped requirements as completed.

## Reviewer

- Stay read-only unless explicitly asked to fix findings. Verify the exact reviewed SHA and state it in the verdict.
- Challenge necessity, simpler designs, scope drift, contract integrity, evidence quality, plan contradictions, and structural rebuild risk.
- Judge the accumulated mechanism, not only whether the latest repair fixes the latest finding. A structural-challenge GO is exact-head review evidence, not a claim that the implementation is globally simple or product-complete.
- Answer explicitly: given the accumulated implementation and current evidence, would you select this mechanism from scratch today?
- Separate blockers, follow-ups, rejected findings, and unresolved product questions. A verdict is evidence for the orchestrator, not merge authorization.
- Return a bounded completion envelope with `review_complete`, verdict, findings, confidence, reviewed SHA, and any unresolved questions. Partial evidence is useful but is not a completed review pass.
