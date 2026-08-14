# Field Report Factory Contract

Field Report defines obligations and evaluates evidence. Native Codex delegation performs work and Sol reviews; required Fable review uses `claude-aws` through the user's shell entrypoint.

## Shared contract

- Coordinators, workstream owners, and executors run `af-onboard-safe`, then `fr context` and their `fr workflow <role>`. Bounded Sol and Fable reviewers use their self-contained briefs instead of AF onboarding or inherited owner history.
- Keep one durable workstream per product outcome. Bind it to its repository, branch, exact head, owner task, and acceptance evidence. Record only material state.
- Product behavior, meaningful scope expansion, security, migrations, durable data, and materially debatable architecture remain user decisions unless explicitly delegated.
- Reconcile reviewer disagreement against the stated claim, code, tests, and product contracts—not by vote, reviewer count, or repeatedly commissioning reviews until one returns GO.
- Preserve user merge authority. Field Report may authorize marking a draft PR ready; it never authorizes merge.
- Scores and structural signals explain the evidence. They never override a verdict, blocker, unresolved question, stale target, or failed deterministic gate.

### Commit policy

- Every commit requires distinct `deep-code-review` and `structural-challenge` Sol reviews of the exact `{base HEAD, staged tree}`. The owner cannot satisfy either lane.
- Any agent may create a workstream for its branch or self-bind the correct existing outcome. No coordinator approval is required.
- Field Report issues immutable briefs, binds them to native task IDs, validates their envelopes, and makes changed targets stale.
- Sol briefs use `fork_turns="none"`. The bounded brief and repository are the review context.
- The repository hook asks `fr gate commit` whether the exact evidence exists.

### Final review and publication policy

- Every final candidate requires distinct exact-head Sol deep and structural reviews. Full review also requires Fable `anthropic.claude-fable-5` through `claude-aws`.
- Mini review may omit only Fable when deterministic eligibility passes and both Sol reviewers agree. Commit review is never reduced.
- Publication requires accepted exact-head lanes, a clean checkout, exact checkout/PR agreement, an open draft PR, settled GitHub checks, no open workstream questions, and one workstream claiming the PR.
- `fr gate publish` evaluates publication. `fr publish` may only mark the draft ready.

### Review envelope

- Every review records its exact delegation, claim, reviewer task or provider run, target, independence, verdict, findings, unresolved questions, summary, explanatory scores, structural signals, and simpler-path reasoning. Changing the claim makes prior review evidence stale.
- Required scores are merge readiness, structural risk, implementation quality, evidence confidence, and outcome confidence. Required signals are necessity, scope drift, contract integrity, and evidence quality.
- A GO may contain nonblocking observations in its summary. Findings and unresolved questions are blocking; do not use them for deferred scope or optional improvements.

## Repository coordinator

- Maintain outcome ownership, sequencing, collision awareness, and publishability visibility.
- Delegate bounded work through Field Report briefs and surface only decisions, collisions, and blockers that need the user.
- Do not answer product or workstream architecture questions for the user.

## Workstream owner

- Own the stated outcome. Choose a coherent, genuinely reviewable delivery unit and state exactly what it claims, what proves it, and what remains outside it.
- Use judgment. Bring uncertainty about product behavior to the user. If consequential technical, scope, or architecture ambiguity remains after inspecting the evidence, consult `claude-aws` for an independent perspective before deciding. Its advice is not approval or review evidence.
- Keep one implementation owner for the current unit. Verify delegated work and required evidence.
- Obtain the required exact-target commit and final reviews. Reviews evaluate the stated claim and do not automatically expand its scope. Substantively address earlier blockers before relying on later evidence; do not commission reviews until one returns GO. A GO with nonblocking observations is complete.
- Summarize stored final evidence clearly, leading with anything that needs attention. Preserve user merge authority.

## Reviewer

- Remain read-only and independently assess whether the exact candidate safely and honestly satisfies its stated claim.
- Block defects that invalidate the claim, or a delivery unit too broad or incoherent to assess reliably.
- Separate other risks, observations, and future work from blockers. Do not convert deferred scope or optional improvements into findings.
- Return a complete exact-target envelope. Do not convert partial evidence into a GO.
