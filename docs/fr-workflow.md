# Field Report Control Loop

Field Report binds a delivery unit and records review evidence. The owner launches reviewers. Field Report does not open pull requests or merge. Agent Fixes owns sessions, names, and todos.

## Shared contract

- Coordinators and workstream owners: if unnamed, run `fr identity --role coordinator|owner` and AF-save that key (or its fallback). Do not ask the user to name you. Attempt `af-onboard-safe` for useful session context. If AF is unavailable or fails, report it briefly and continue; AF is never a work gate. Reviewers must not use MCP servers or AF, and must not save an AF name.
- Keep one workstream per product outcome. Bind it to its repository, branch, claim, and owner session. Session names are `{project}/{role}` with fallback `{project}/{role}-2` (examples: `aon/coordinator`, `ad/owner`). Persist only material review state in Field Report. File todos as AF issues in that repo's AF namespace — `aon`, `ad`, and so on — not in Field Report.
- Read this repository's `merge-ready-review.md` when judging merge quality. Field Report does not copy or replace it.
- Product behavior, meaningful scope expansion, security, migrations, durable data, and materially debatable architecture remain user decisions. Catch overengineering. Do not make those calls without asking the user. If consequential technical or architecture ambiguity remains after inspecting the evidence, consult Astra or Grok once; that advice is not review evidence and not a gate.
- Reviews never require permission. Commission CRR, MRR, and court without asking. If Auto-review blocks a review CLI, retry it; that is not a user question. Repo `.cursor/permissions.json` only steers Auto-review; it is not the IDE allowlist.
- Reconcile MRR findings against the stated claim, code, and tests—not by vote, shopping models, or treating candidate-authored docs as product law.
- Preserve user merge authority. Do not auto-open a pull request. After the pre-CI MRR gate is READY, the owner may open a PR or the user may. Field Report never merges.
- Scores explain the evidence. They never override a verdict, unreconciled MRR finding, stale target, or failed deterministic gate. `fr context` and `fr review status` print the latest scores and structural risk for each seat on this claim even when the gate is blocked. Higher structural risk is worse.
- Cursor Cloud Agents invoke Astra (`codex`) and Fable (`claude`) on the user's machine only while a My Machines worker for that checkout is running. Prefer a native same-type path when the invoking agent is that family; Cloud Agents are third-party and should use `fr machines invoke`. Field Report does not probe host accessibility or start workers. Start a worker for this checkout only with Cursor's `agent worker start --name local --worker-dir <this-repo>`. If the invoke fails, report it; do not substitute Cursor-hosted models. Use ordinary `claude`, never `claude-aws`.

### CRR

- Before you run `git commit` on a commit you intend to keep, stop and run CRR against the exact staged tree: `fr review brief <id> --kind crr --role crr`. Launch 1–2 fresh subagents. Prefer local models; use cloud only if local cannot produce an envelope. A green checkout hook is not CRR. WIP or amend commits are owner judgment.
- The envelope is small: verdict, findings, summary, scores. Those findings are for the owner on this tree. CRR records persist, but they are not a durable SHA-by-SHA ledger.
- The owner cannot review their own work. A fresh subagent of the builder's model can.
- The repository hook only asks `fr gate checkout` whether this branch is bound. It does not run a panel. `fr gate crr` is owner-invoked after CRR. Do not wrap `git commit`, and do not move this panel into the hook if someone skips it. Installed v3 hooks still call `fr gate commit`; that is a checkout alias, not a CRR gate. Reinstall with `fr hook install` to pick up the v4 text. Older Field Report-managed hooks are replaced; a non-Field-Report hook is preserved and chained.

### MRR

- Run MRR before a pull request is opened (`fr gate open` needs exact-head evidence). Fetch `origin` so local `origin/<base>` is current before that first brief. Ordinary `fr context`, briefing after that, recording, and status derive the target from local refs; they do not contact GitHub.
- After the first panel, feature work and bot/CI cycles use CRR. Do not commission MRR because HEAD moved. `fr context` tracks last MRR SHA vs current HEAD.
- Final MRR happens when the user asks. The agent may argue that the delta is not substantive enough to re-run the whole panel. Diff size is a proxy for sensitivity, not the test. The user's word always rules. If they agree to skip, record `fr review waive --reason <text>` for this HEAD only. A skip requires a recorded actor (`CODEX_THREAD_ID`, the bound owner session, or `--actor`) and is refused without one. Do not record a skip unless they explicitly agreed. A later push drops the skip. Skip is the whole panel, not one persona. `fr gate open` never uses a skip; `fr gate bots` can.
- MRR seats `deep-code-review`, `structural-challenge`, and `fable-challenge`. Intended models are Astra via Codex, Grok 4.6 via Cursor CLI, and Fable 5 via `claude`. READY requires the exact head, the exact base head, and three finding-free persona GOs. BLOCKED is a valid successful Field Report output. Scores never override READY. Any completed occupying envelope fills that job on this target and claim; a printed brief does not occupy. Substitution is allowed only while that job has zero envelopes, requires a non-empty `--substitution-reason` (missing binary, authentication failure, or unavailable model before a usable run begins — not a started hang), and must print on status (for example `structural-challenge: GO via Astra; intended Grok was substituted: cursor-agent not on PATH`). A completed NO_GO cannot be escaped by another model. Court is evidence-only: `fr review adjudicate` cannot fill a job or substitute a model, cannot reuse a participating reviewer, cannot later fill a persona job with the same reviewer task ID, and is one shot per occupying packet. READY also refuses when the current owner is a court reviewer on this target. A full reject grants exactly one rerun of the model that produced the NO_GO; that rerun brief must be created after the court. `still_present` or a rejected rerun that is again NO_GO means fix on a new head. Field Report does not record provider failure, start/hang/unavailable states, or 2-of-3.
- Reviewers must not use MCP servers or AF, and must not inherit the owner conversation. `fr-cursor-review` launches Grok with an empty user-level MCP file; it does not hide repository-scoped Cursor MCP. Isolation is those MCP and Cursor auth files only — not `~/Library`. Record the original provider output with `fr review record <id> --file <raw-output> [--delegation <original-id>]`. FR unwraps supported provider JSON/fences and fills omitted identity from the original brief and binding; supplied conflicts are rejected. One reviewer task or provider run binds to one review delegation per workstream.
- Durable findings live on MRR reviews until the owner addresses them. CRR findings do not. A GO cannot carry findings, unresolved items, or still_present. Exact-target packets (head and baseHead) go through court, including a NO_GO that rests only on still_present; `deep-code-review` carries outstanding issues from a different head, base, or claim revision. Court rejection is scoped to that exact head, base, claim, and claim revision; it does not suppress the finding after a head, base, or claim-revision change. Court authorizes a rerun against the outstanding occupant packet it briefed. `still_present` does not become a full reject if a later review resolves the ID. A stale adverse envelope occupies again if that exact target returns. The authorized rerun brief must be created after the court and cannot reuse a pre-court reviewer task ID. Substitution attestation is pinned to the brief; READY joins a substituted occupant to that brief.
- `fr gate open` is the pre-CI / ready-for-bots check. It does not open the PR. `fr gate bots` is the post-CI merge-readiness check on an open PR. An already-ready PR with that evidence is fine; do not convert it to draft. An empty GitHub check rollup is not evidence that CI ran; `fr gate bots` stays BLOCKED until checks are observed.

### After a pull request is open

- Watch GitHub checks. Flake vs real failure is owner judgment. If it is on the border, consult Astra or Grok once before deciding whether to address it. That consult is not a hard gate.
- Fix-and-push still uses CRR. Do not restart MRR because HEAD moved. Wait until the user asks for final MRR.
- Bot comments are owner/`gh` triage, not a new persona panel.
- If `main` moves and the PR head did not, do not redo MRR. If merge or rebase changes the head, that is a new HEAD; still wait for the user to ask for final MRR.

### Review envelope

- Every review records its exact delegation, claim, reviewer task or provider run, target, independence, verdict, findings, summary, and explanatory scores. MRR reviews also record unresolved items, structural signals, and simpler-path reasoning. MRR models are `gpt-6-astra`, `grok-4.6`, or `claude-fable-5`; launch route is provenance.
- Each newly recorded review retains the exact submitted source text alongside the validated result, so deleting the temporary output file does not erase the submitted evidence. Older records lack this source. This is an audit record of what the owner submitted, not proof that the owner did not edit it before submission. Submit the original output; never change verdicts, findings, limitations, completion claims, or provenance. `pass` is not a GO.
- Persona briefs pin their intended model, and recorded evidence retains that seating. A new intended model governs new briefs only. Historical Sol deep reviews and the initial unpinned Astra briefs retain their original meaning; do not fabricate substitution reasons for them.
- The delivery claim is a dedicated workstream field (`fr update <id> --claim`). Changing the claim makes prior MRR evidence stale; ordinary summary updates do not.
- Field Report assigns durable IDs only to MRR findings and unresolved items. Those stay outstanding until a later MRR review explicitly reconciles the ID. A newer GO, a changed SHA, or an edited claim never silently clears them. CRR findings never enter that ledger.
- The `deep-code-review` MRR brief carries outstanding issues from an older head. Exact-head occupying packets go through `fr review adjudicate`. A review may reconcile only IDs delivered in its own brief.
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
- Keep a one-line next action with `fr update <id> --next`. Update it when you stop or the next step changes. It is a sticky note, not a todo ledger. AF issues remain the todos.
- CRR before you run `git commit` on a commit you intend to keep. A green checkout hook is not CRR. WIP and amend are owner judgment. MRR before opening a PR. After that, CRR through churn. Final MRR only when the user asks; argue substantiveness if a skip seems right, then wait. Reviews never require permission. Launch each intended model. A completed envelope occupies that job. If the intended model cannot start before any occupant exists, substitute with `--substitution-reason`; repair or resume a started hang. Do not record provider failure and do not shop after a NO_GO. Three finding-free persona GOs are READY. Court an occupying NO_GO once with `fr review adjudicate`.
- Do not auto-open a pull request. After `fr gate open` is READY, you may open one or leave that to the user. Never merge.
- Summarize stored MRR evidence clearly, leading with anything that needs attention.

## Reviewer

- Remain read-only. Do not use MCP servers or AF. Do not save an AF name.
- Inspect the exact target with the brief's `inspection.command`. Do not inherit owner conversation or run owner skills.
- CRR stays short: competence and gaps. MRR inspects the complete changed authority boundary; the stated claim is context, not a scope limit.
- Attempt to falsify the candidate; do not defer to the owner's framing, passing tests, implementation effort, or other reviewers.
- Account for every delivered MRR issue ID. Findings are only for newly discovered issues. Reconcile only IDs your brief delivered. A NO_GO may rest on `still_present` reconciliations alone; do not duplicate a delivered issue into findings to make the envelope recordable.
- Separate other risks, observations, and future work from blockers. Return a complete envelope. Do not convert partial evidence into a GO. Omit routing fields rather than guessing them; FR supplies them from the brief and binding. Conflicting identity or ambiguous content needs correction by the same reviewer on the same delegation. Missing required inspection is adverse evidence, not a formatting problem.

## What not to rebuild

These are swings this program already made. Do not take them again.

- Do not grow Field Report back into a portfolio OS: session aliases, `fr catchup` / heartbeat / watch, checkpoints, holds, `fr commit`, in-repo snapshots, or a second issue tracker. A one-line `--next` sticky note is allowed. AF owns people and todos. GitHub owns PRs. This repository's `merge-ready-review.md` owns merge quality.
- Do not put a review panel in the git hook, wrap `git commit`, or answer a skipped panel by closing "bypass" paths. That path produced a week of identity-hardening commits and `--no-verify` pressure. The hook stays a branch-binding check.
- Do not collapse MRR into a generic family panel, and do not add mini-review eligibility to skip a persona. Named seats, occupying envelopes, three GOs. Do not restore a provider-fail command, named backup menus, or 2-of-3.
- Do not strip scores, exact-head evidence, AF onboarding (best-effort, never a gate), fresh-context workers, user-held product decisions, MRR scope beyond the claim, adversarial stance, or durable MRR findings. Each of those was deleted in a simplify and had to be restored. CRR findings staying out of the durable ledger is the one intentional exception. Do not put a live GitHub round-trip inside ordinary MRR target derivation. Do not hide scores when a gate is blocked. Do not restore schema v1 migrate.
- Do not hand-rewrite reviewer output to fix schema, turn pass into GO, remove limitations, or replace delegation IDs. Supported formatting is handled by the recorder; resume the same reviewer for corrections that require judgment. Do not restore `claude-aws`, Fable plan-mode, or unrestricted `Bash(git *)`.
- Do not add `fr question`. Product questions go to the user. Do not make coordinators mute relays or factory owners; they assign and sequence in the repo namespace.
- Do not add a user-permission step before reviews.
- Keep one canonical skill source, with launch recipes in the skill because agents follow `SKILL.md`. Do not maintain host-specific copies, and do not replace the skill with a pointer that nobody reads.
