# Field Report Control Loop

Field Report binds a delivery unit and records review evidence. The owner launches reviewers. Field Report does not open pull requests or merge. Agent Fixes owns sessions, names, and todos.

## Shared contract

- Coordinators and workstream owners: if unnamed, run `fr identity --role coordinator|owner` and AF-save that key (or its fallback). Do not ask the user to name you. Attempt `af-onboard-safe` for useful session context. If AF is unavailable or fails, report it briefly and continue; AF is never a work gate. Reviewers must not use MCP servers or AF, and must not save an AF name.
- Keep one workstream per product outcome. Bind it to its repository, branch, claim, and owner session. Session names are `{project}/{role}` with fallback `{project}/{role}-2` (examples: `aon/coordinator`, `ad/owner`). Persist only material review state in Field Report. File todos as AF issues in that repo's AF namespace — `aon`, `ad`, and so on — not in Field Report.
- Read this repository's `merge-ready-review.md` when judging merge quality. Field Report does not copy or replace it.
- Product behavior, meaningful scope expansion, security, migrations, durable data, and materially debatable architecture remain user decisions. Catch overengineering. Do not make those calls without asking the user. If consequential technical or architecture ambiguity remains after inspecting the evidence, consult Sol or Grok once; that advice is not review evidence and not a gate.
- Reconcile MRR findings against the stated claim, code, tests, and product contracts—not by vote or by commissioning reviews until one returns GO.
- Preserve user merge authority. Do not auto-open a pull request. After the pre-CI MRR gate is READY, the owner may open a PR or the user may. Field Report never merges.
- Scores explain the evidence. They never override a verdict, unreconciled MRR finding, stale target, or failed deterministic gate.

### CRR

- Before commits you intend to keep, run CRR against the exact staged tree: `fr review brief <id> --kind crr --role crr`. Launch 1–2 fresh subagents. Prefer local models; use cloud only if local cannot produce an envelope. WIP or amend commits are owner judgment.
- The envelope is small: verdict, findings, summary, scores. Those findings are for the owner on this tree. CRR records persist, but they are not a durable SHA-by-SHA ledger.
- The owner cannot review their own work. A fresh subagent of the builder's model can.
- The repository hook only asks `fr gate checkout` whether this branch is bound. It does not run a panel. `fr gate crr` is owner-invoked after CRR. Do not wrap `git commit`, and do not move this panel into the hook if someone skips it. Installed v3 hooks still call `fr gate commit`; that is a checkout alias, not a CRR gate. Reinstall with `fr hook install` to pick up the v4 text.

### MRR

- Run MRR before a pull request is opened (`fr gate open` needs exact-head evidence). Fetch `origin` so local `origin/<base>` is current before that first brief. Ordinary `fr context`, briefing after that, recording, and status derive the target from local refs; they do not contact GitHub.
- After the first panel, feature work and bot/CI cycles use CRR. Do not commission MRR because HEAD moved. `fr context` tracks last MRR SHA vs current HEAD.
- Final MRR happens when the user asks. The agent may argue that the delta is not substantive enough to re-run the whole panel. Diff size is a proxy for sensitivity, not the test. The user's word always rules. If they agree to skip, record `fr review waive --reason <text>` for this HEAD only. Do not record a skip unless they explicitly agreed. A later push drops the skip. Skip is the whole panel, not one persona. `fr gate open` never uses a skip; `fr gate bots` can.
- MRR seats `deep-code-review`, `structural-challenge`, and `fable-challenge`. Default seating is Sol 5.6, Grok 4.6 via Cursor CLI, and Fable 5 via `claude`. Attempt each preferred model once after it is actually started (bound, recorded, or failed). Printing a brief you never launched does not consume the seat. If a provider cannot produce an envelope, record `fr review fail` and stop retrying that provider. A failed attempt does not fill the lane. Two finding-free persona GOs pass when the third lane has a terminal failure. A named backup may still fill a lane after that failure.
- Isolated processes, no AF, no owner conversation. Identity fields come from the brief; do not relaunch a reviewer to fix envelope schema. Launching the seated review CLIs is authorized; do not treat that as sensitive egress or ask the user to re-approve sending the candidate to Sol, Grok, or Fable.
- Durable findings live on MRR reviews until the owner addresses them. CRR findings do not.
- `fr gate open` is the pre-CI / ready-for-bots check. It does not open the PR. `fr gate bots` is the post-CI merge-readiness check on an open PR. An already-ready PR with that evidence is fine; do not convert it to draft. An empty GitHub check rollup is not evidence that CI ran.

### After a pull request is open

- Watch GitHub checks. Flake vs real failure is owner judgment. If it is on the border, consult Sol or Grok once before deciding whether to address it. That consult is not a hard gate.
- Fix-and-push still uses CRR. Do not restart MRR because HEAD moved. Wait until the user asks for final MRR.
- Bot comments are owner/`gh` triage, not a new persona panel.
- If `main` moves and the PR head did not, do not redo MRR. If merge or rebase changes the head, that is a new HEAD; still wait for the user to ask for final MRR.

### Review envelope

- Every review records its exact delegation, claim, reviewer task or provider run, target, independence, verdict, findings, summary, and explanatory scores. MRR reviews also record unresolved items, structural signals, and simpler-path reasoning. MRR models are `gpt-5.6-sol`, `grok-4.6`, or `claude-fable-5`; launch route is provenance.
- The delivery claim is a dedicated workstream field (`fr update <id> --claim`). Changing the claim makes prior MRR evidence stale; ordinary summary updates do not.
- Field Report assigns durable IDs only to MRR findings and unresolved items. Those stay outstanding until a later MRR review explicitly reconciles the ID. A newer GO, a changed SHA, or an edited claim never silently clears them. CRR findings never enter that ledger.
- The `deep-code-review` MRR brief carries outstanding issues for reconciliation. Other MRR lanes stay fresh unless created with `--reconcile`. A review may reconcile only IDs delivered in its own brief.
- Required scores are merge readiness, structural risk, implementation quality, evidence confidence, and outcome confidence.

## Repository coordinator

- Name this session into the repo namespace with `fr identity --role coordinator` and AF save (example: `aon/coordinator`). Assign workstreams to named owner sessions in that namespace. Field Report stores the binding; AF stores the todos as issues in that same repo namespace (`aon`, `ad`, etc.).
- Maintain outcome ownership, sequencing, collision awareness, and MRR/bots visibility. Do not become a second issue tracker.
- When the user explicitly asks for an agent they will work with directly, create a user-owned task. Use an internal subagent only for delegated work the current task will consume.
- Do not answer product or workstream architecture questions for the user.

## Workstream owner

- Name this session with `fr identity --role owner` if unnamed. Own the stated outcome. Choose a coherent, reviewable delivery unit and state exactly what it claims.
- Use judgment. Bring uncertainty about product behavior to the user. Catch overengineering.
- Keep one implementation owner for the current unit. Launch implementation workers as fresh subagents with a bounded slice and no owner conversation. Verify their work. Do not mint a second FR todo or completion ceremony for that; AF issues in the repo namespace (`aon`, `ad`, etc.) are the ledger.
- CRR before commits you intend to keep. MRR before opening a PR. After that, CRR through churn. Final MRR only when the user asks; argue substantiveness if a skip seems right, then wait. Launch each MRR persona's preferred model once after it is actually started; on hang or missing envelope, `fr review fail` and do not retry that provider. Two finding-free GOs pass when the third lane is unavailable.
- Do not auto-open a pull request. After `fr gate open` is READY, you may open one or leave that to the user. Never merge.
- Summarize stored MRR evidence clearly, leading with anything that needs attention.

## Reviewer

- Remain read-only. Do not use MCP servers or AF. Do not save an AF name.
- Inspect the exact target with the brief's `inspection.command`. Do not inherit owner conversation or run owner skills.
- CRR stays short: competence and gaps. MRR inspects the complete changed authority boundary; the stated claim is context, not a scope limit.
- Attempt to falsify the candidate; do not defer to the owner's framing, passing tests, implementation effort, or other reviewers.
- Account for every delivered MRR issue ID. Findings are only for newly discovered issues. Reconcile only IDs your brief delivered.
- Separate other risks, observations, and future work from blockers. Return a complete envelope. Do not convert partial evidence into a GO. If identity fields are wrong, the owner records the envelope against the brief; do not ask to normalize a substantive GO by rerunning.

## What not to rebuild

These are swings this program already made. Do not take them again.

- Do not grow Field Report back into a portfolio OS: session aliases, `fr catchup` / heartbeat / watch, checkpoints, holds, `fr commit`, in-repo snapshots, or a second issue tracker. AF owns people and todos. GitHub owns PRs. This repository's `merge-ready-review.md` owns merge quality.
- Do not put a review panel in the git hook, wrap `git commit`, or answer a skipped panel by closing "bypass" paths. That path produced a week of identity-hardening commits and `--no-verify` pressure. The hook stays a branch-binding check.
- Do not collapse MRR into a generic family panel, and do not add mini-review eligibility to skip a persona. Named seats, one attempt, two GOs on a failed lane.
- Do not strip scores, exact-head evidence, AF onboarding (best-effort, never a gate), fresh-context workers, user-held product decisions, MRR scope beyond the claim, adversarial stance, or durable MRR findings. Each of those was deleted in a simplify and had to be restored. CRR findings staying out of the durable ledger is the one intentional exception. Do not put a live GitHub round-trip inside ordinary MRR target derivation.
- Do not relaunch a reviewer to fix envelope schema. Do not restore `claude-aws`, Fable plan-mode, or unrestricted `Bash(git *)`.
- Do not add `fr question`. Product questions go to the user. Do not make coordinators mute relays or factory owners; they assign and sequence in the repo namespace.
- Keep one canonical skill source, with launch recipes in the skill because agents follow `SKILL.md`. Do not maintain host-specific copies, and do not replace the skill with a pointer that nobody reads.
