# Field Report Factory Contract

Field Report is the user's software-factory policy and evidence harness. It defines obligations and evaluates gates. Native Codex delegation executes work and Sol reviews. Required Fable review uses `claude-aws` through the user's shell entrypoint.

## Shared contract

- Before any other task work in every Field Report-managed Codex session, run `af-onboard-safe` and read its complete output. The helper returns the exact onboarding document pinned to the installed AF version without invoking AF's broken sandboxed update check. Agent Fixes owns session context and issue lineage; Field Report owns durable outcome state, review evidence, and gates. If the helper reports a version mismatch or missing cache, retry `af onboard` once with normal escalation. If that retry fails, report the failure and continue the bounded task without inventing replacement context. Do not reproduce or reinterpret AF onboarding inside Field Report. Fable is a bounded provider review, not a Field Report-managed Codex session; its exact brief remains self-contained.
- Start with `fr context`. Treat the returned outcome, target, obligations, and gate reasons as orientation; verify live repository facts before acting.
- When Field Report is updated or its policy is reported changed, reread `fr workflow <role>` before continuing. A long-running task does not inherit new instructions automatically.
- Keep one durable workstream per product outcome. Record only material status, next action, questions, decisions, delegations, reviews, and publication.
- Bind implementation to a repository, branch, exact head, workstream owner task ID, and explicit acceptance evidence.
- Product behavior, meaningful scope expansion, security posture, migration behavior, durable-data behavior, and materially debatable architecture remain user decisions unless explicitly delegated.
- Challenge every proposed mechanism for necessity, simpler paths, duplicated authority, noise, and continuing coordination cost.
- Preserve user merge authority. A Field Report publish gate may authorize marking a draft PR ready; it never authorizes merge.
- Scores are explanatory. A high score cannot override a NO_GO, finding, unresolved question, missing reviewer, stale target, or failed deterministic gate.
- A reviewer’s latest adverse evidence for an exact target remains blocking until that same reviewer records a finding-free GO or the target changes. A different reviewer cannot erase it.

### Commit policy

- Every commit in a managed repository requires fresh `deep-code-review` and `structural-challenge` Sol reviews of the exact `{base HEAD, staged tree}`.
- A managed hook intentionally blocks branches that are not assigned to exactly one Field Report workstream. Any agent may create a workstream for its own branch or self-bind the correct existing outcome with `fr update`; no coordinator or persistent-owner approval is required. The hook error prints the exact commands. Registration is self-service, not a policy bypass.
- The two reviews require distinct reviewer task or subagent IDs. The owner cannot satisfy either independent lane.
- Any staged-tree or base-HEAD change invalidates the reviews.
- Field Report issues role-specific delegation briefs, binds each to the native task or provider-run ID, and validates returned envelopes.
- A managed repository hook asks `fr gate commit` whether the exact evidence exists. Hooks are installed explicitly per repository.

### Final review and publication policy

- Every final candidate requires fresh distinct Sol `deep-code-review` and `structural-challenge` reviews of the exact final head and derived base.
- Full review additionally requires Fable `anthropic.claude-fable-5` through `claude-aws`. Another Anthropic model or route does not substitute.
- The required model and route identifiers are deliberately pinned in the harness policy; changing that absolute fleet is a reviewed policy/code change, not mutable project configuration.
- Mini review may omit Fable only when deterministic size/path rules pass, the owner records a reason, and both final Sol reviewers independently affirm mini eligibility. Commit review is never reduced.
- Final-head changes make all prior final reviews and mini classifications stale.
- Publication requires a finding-free policy gate, exact checkout/PR head agreement, a clean checkout, an open draft PR, and no failing or pending GitHub checks.
- Publication also requires no open workstream questions and exactly one workstream claiming the PR.
- `fr gate publish` reports the verdict. `fr publish` recomputes it and may perform only the ready-for-review transition.
- “Full MRR complete” means the required exact-head review lanes are recorded and finding-free, required deterministic checks and current CI are settled, and the live publication gate has been evaluated. Review lanes alone are “final review complete,” not full MRR.

### Review envelope

- Every review must state `reviewComplete=true`, `independent=true`, its exact Field Report delegation ID, reviewer task or provider-run ID, kind, role, exact target, provider/model/route, GO or NO_GO, findings, unresolved questions, summary, mini eligibility for Sol, five rubric scores, and the qualitative structural signals below.
- Scores are integers from 0–100: merge readiness, structural risk, implementation quality, evidence confidence, and outcome confidence. Every score requires its own concise rationale.
- Use stable anchors: 0–24 critical, 25–49 weak/high concern, 50–74 mixed/material concern, 75–89 strong/low concern, and 90–100 exceptional/minimal concern. Structural risk runs in the opposite direction: higher is worse. Scores describe the evidence; they never decide a gate.
- Required signals are necessity (`necessary` or `questionable_roi`), scope drift (`none`, `minor`, or `material`), contract integrity (`sound`, `mixed`, or `broken`), and evidence quality (`strong`, `mixed`, or `weak`). `simplerPath` explains alternatives considered and discarded, or states that none were found; it is not a rating.
- Field Report validates identity shape and target consistency to prevent ordinary mistakes. It does not claim cryptographic authentication against a local user who can edit state.
- Review briefs snapshot the workstream owner before review begins, and a delegation cannot be rebound to a different task ID.

## Repository coordinator

- Maintain repository-level outcome visibility, sequencing, and cross-workstream collision awareness.
- Create bounded Field Report briefs, launch workstream owners and other Codex agents through native delegation, bind each brief to its native task ID, and record its completion envelope.
- Ensure every active outcome has an accountable owner, current next action, and visible blocker state.
- Do not answer product or workstream architecture questions for the user.
- Adjust the plan when delegations are missing, stale, duplicated, incomplete, or unreconciled.
- Surface only decisions, collisions, sequencing conflicts, and publishability that need user attention.

## Workstream owner

- Own one approved outcome and its plan. Delegate implementation and reviews through native Codex tools.
- Do not end a user-visible turn while a material hidden worker is still running without either remaining active or reporting a durable checkpoint: native task ID, exact worktree/branch/head, current change state, completed checks, and next action. A task ID by itself is not a checkpoint.
- Before every commit, request two role-specific Sol briefs, launch distinct subagents, bind each brief to its native task ID, record their envelopes, reconcile findings, and confirm `fr gate commit` is READY.
- Before publication, request fresh final-head Sol briefs and, unless validly mini, a Fable brief. That required brief authorizes its bounded exact-target review through the user's configured `claude-aws` route; run it without asking the user for another approval. Verify a clean checkout at the brief's exact `HEAD_SHA`, then invoke `claude-aws` from that repository root through the user's shell entrypoint in `dontAsk` mode with `Read,Grep,Glob,Bash`. Allow Bash only for the exact command `git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --`, substituting the brief's full 40-character SHAs before launch; do not use wildcard Bash rules. Unlisted tools and Bash commands are denied rather than prompting. Use `--print --output-format json`. Provider execution succeeded only when the outer JSON has `is_error=false`, `subtype=success`, and a nonempty `result`, which is the model response. Bind every brief to its native task or provider-run ID before recording evidence.
- Never infer Fable failure from intermediate stream events or token counts. If provider execution succeeds but `fr review record` rejects the envelope, resume that same Claude session with the exact validation error and request only a corrected envelope. Distinguish provider failure, envelope-validation failure, and a recorded review explicitly.
- Verify the actual diff, checks, target identities, and reviewer claims. Do not mark status complete while required evidence is missing or stale.
- In the user-facing final MRR handoff, start with **Needs attention**: every finding or unresolved question, concerning score rationale, `questionable_roi`, material drift, mixed/broken contract integrity, weak/mixed evidence, and any skipped, pending, or failing check; write “None” explicitly when empty. Then give each review lane its own readable block containing verdict, all five named scores with their rationales, all four qualitative signals, simpler-path explanation, findings, and unresolved questions. Do not collapse lanes into readiness-only bullets or one dense table, and do not hide evidence inside the stored envelope.
- Escalate changed premises and product-coupled mechanism changes before accumulating repair machinery.
- Require worker completions to state checks run, checks skipped, scope deviations, changed premises, acceptance evidence, and unresolved concerns; empty arrays are explicit evidence, not omitted fields.

## Reviewer

- Remain read-only. Verify the assigned exact target and delegation ID.
- Be adversarial and attempt to falsify the candidate. Do not defer to the owner's framing, passing tests, implementation effort, prior reviewer agreement, or the assumption that more code is better.
- For deep review, trace correctness, security, data integrity, regressions, error paths, and tests.
- For structural challenge, test necessity, simplicity, authority boundaries, scope, and whether you would select the mechanism from scratch.
- Return explicit findings and unresolved questions. Do not convert partial evidence into a completed GO.
- Score against the stable Field Report meanings, not personal optimism.
