# Field Report Control Loop

Field Report binds a delivery unit and records review evidence. The owner launches reviewers. Field Report does not open pull requests or merge. Agent Fixes, when installed, owns sessions and names. Each project's tracker (AF or Linear, set with `fr project add|update --tracker`) owns todos.

## Shared contract

- Coordinators and workstream owners: if AF is installed and you are unnamed, run `fr identity --role coordinator|owner` and AF-save that key (or its fallback); without AF, skip naming. Do not ask the user to name you. Attempt `af-onboard-safe` for useful session context. If AF is unavailable or fails, report it briefly and continue; AF is never a work gate. Reviewers must not use MCP servers or AF, and must not save an AF name.
- Keep one workstream per product outcome. Bind it to its repository, branch, claim, and owner session. Session names are `{project}/{role}` with fallback `{project}/{role}-2` (examples: `aon/coordinator`, `ad/owner`). Persist only material review state in Field Report. File todos in the project's tracker, which `fr context` prints on its `Todos:` line — AF issues in that repo's namespace (`aon`, `ad`, and so on) or the named Linear team and label — not in Field Report. Linear issues are visible to the team; file only real follow-ups.
- Read this repository's `merge-ready-review.md` when judging merge quality. Field Report does not copy or replace it.
- Product behavior, domain facts, meaningful scope expansion, security, migrations, durable data, and materially debatable architecture remain user decisions. Catch overengineering. Do not make those calls without asking the user. Schema, migrations, comments, and existing code show what was built; they are not the product contract. Product and domain questions go to the user, especially when the answer would shape data modeling or a one-way decision. Stop and ask; do not infer them from the repo. Those questions never go to a reviewer model. Record each answer with `fr decide <id> <text>`; every review brief carries the list as settled. If consequential technical or architecture ambiguity remains after inspecting the evidence, consult one seated model (`fr seats`) once; that advice is not review evidence and not a gate.
- Before implementing or recommending a behavior-changing fix, describe one concrete scenario: what happens today, what should happen afterward, and what user instruction or previously approved product rule establishes that outcome. Existing code, tests, schema, agent-written documentation, and reviewer agreement establish behavior, not user intent. If the proposed outcome requires an unsettled product choice, explain it in plain English, recommend an option, and ask before implementing that part or declaring it ready. Continue independent work. Reuse prior explicit decisions without asking again. Reviewers return unsettled product choices as questions for the user, not as NO_GOs.
- Reviews never require permission. Commission CRR and MRR without asking. If Auto-review blocks a review CLI, retry it; that is not a user question. Repo `.cursor/permissions.json` only steers Auto-review; it is not the IDE allowlist.
- Settle an MRR finding by fixing it or by the user's explicit acceptance (`fr review accept`), not by vote, shopping models, or treating candidate-authored docs as product law.
- Preserve user merge authority. Do not auto-open a pull request. After the pre-CI MRR gate is READY, the owner may open a PR or the user may. Field Report never merges.
- Scores explain the evidence. They never override a verdict, open MRR finding, stale target, or failed deterministic gate. `fr context` and `fr review status` print the latest scores and structural risk for each seat on this claim even when the gate is blocked. Higher structural risk is worse.
- Cursor Cloud Agents invoke the host `codex` and `claude` CLIs on the user's machine only while a My Machines worker for that checkout is running. Prefer a native same-type path when the invoking agent is that family; Cloud Agents are third-party and should use `fr machines invoke`. Field Report does not probe host accessibility or start workers. Start a worker for this checkout only with Cursor's `agent worker start --name local --worker-dir <this-repo>`. If the invoke fails, report it; do not substitute Cursor-hosted models. Use ordinary `claude`, never `claude-aws`.

### CRR

- Before you run `git commit` on a commit you intend to keep, stop and run CRR against the exact staged tree: `fr review brief <id> --kind crr --role crr`. Launch 1–2 fresh subagents. Prefer local models; use cloud only if local cannot produce an envelope. A green checkout hook is not CRR. WIP or amend commits are owner judgment.
- The envelope is small: verdict, findings, summary, scores. Those findings are for the owner on this tree. CRR records persist, but they are not a durable SHA-by-SHA ledger.
- The owner cannot review their own work. A fresh subagent of the builder's model can.
- The repository hook only asks `fr gate checkout` whether this branch is bound. It does not run a panel. `fr gate crr` is owner-invoked after CRR. Do not wrap `git commit`, and do not move this panel into the hook if someone skips it. Installed v3 hooks still call `fr gate commit`; that is a checkout alias, not a CRR gate. Reinstall with `fr hook install` to pick up the v4 text. Older Field Report-managed hooks are replaced; a non-Field-Report hook is preserved and chained.

### MRR

- Run MRR before a pull request is opened (`fr gate open` needs a deciding review from every seat; a GO carried from an earlier commit counts, and the READY line names each seat that has not reviewed HEAD). Fetch `origin` so local `origin/<base>` is current before that first brief. Ordinary `fr context`, briefing after that, recording, and status derive the target from local refs; they do not contact GitHub.
- After the first panel, feature work and bot/CI cycles use CRR. Do not commission MRR because HEAD moved. Each seat's review of HEAD or an ancestor carries forward, and the gate prints the commits that seat has not seen.
- Final MRR happens when the user asks. The agent may argue that the delta is not substantive enough to re-run the panel. Diff size is a proxy for sensitivity, not the test. The user's word always rules.
- MRR seats `correctness` (bugs, security, data integrity, error paths, tests), `design` (how it is built: whether it is needed, simplicity, boundaries), and `intent` (what it does: whether it matches the stated outcome, claim, and user decisions, and only that). The user's config file (`fr seats`; `~/.config/field-report/config.json` or `FIELD_REPORT_CONFIG`) lists each seat's valid models (the first is the default) and how each launches. The shipped three-lab panel is a suggestion; one model may serve several seats. Field Report hardcodes no model names: a new model is a config edit. Only a model the seat listed when briefed can fill it. Each seat is decided by its review of the commit nearest HEAD (HEAD or an ancestor). READY means every seat's deciding review is a GO, or a NO_GO whose findings the user accepted, from distinct reviewers who are not the owner. A GO on an earlier commit carries forward and the gate says which commits that seat has not seen. After a fix, rerun only the seat that said NO_GO; its brief lists its own open findings to verify. A seat reviews each exact head once: a second review of the same head cannot clear a NO_GO there. BLOCKED is a valid successful Field Report output. Scores never override READY. A printed brief does not settle a seat; a recorded review does. Field Report does not record provider failure or start/hang/unavailable states.
- Reviewers must not use MCP servers or AF, and must not inherit the owner conversation. `fr-cursor-review` launches Cursor-hosted seats with an empty user-level MCP file and the brief on stdin; it does not hide repository-scoped Cursor MCP. The temporary home links the two Cursor settings/state files and, on macOS, the existing `~/Library/Keychains/login.keychain-db` so saved login still works. It does not copy credentials or link the rest of `~/Library`. Record the original provider output with `fr review record <id> --file <raw-output> [--delegation <original-id>]`. FR unwraps supported provider JSON/fences and fills omitted identity from the original brief and binding; supplied conflicts are rejected. One reviewer task or provider run binds to one review delegation per workstream.
- MRR findings live on the review that raised them, with workspace-wide IDs (`F1`, `F2`, ...). A finding blocks until the seat's rerun on a fixed head says GO, or until the user accepts it: `fr review accept <id> --finding <F-id> --reason <text> --actor <who>`. Record an acceptance only when the user explicitly accepted that finding; `--actor` is required and names who accepted it, and the gate prints it. CRR findings never block MRR.
- `fr gate open` is the pre-CI / ready-for-bots check. It does not open the PR. `fr gate bots` is the post-CI merge-readiness check on an open PR. An already-ready PR with that evidence is fine; do not convert it to draft. An empty GitHub check rollup is not evidence that CI ran; `fr gate bots` stays BLOCKED until checks are observed. It also stays BLOCKED while any review thread, from a bot or a person, is unresolved.

### BRR

- Build-ready review is for work that spans several pull requests, run when the user asks for it or agrees to it. It is not a Field Report kind: no brief, record, or gate. The user's sign-off is the only gate. Follow the `brr` skill.
- Sign off on direction, not detail: sketch the arcs, plan only the arc that starts now as PRs, and investigate later arcs just enough to find landmines (one-way decisions, feasibility unknowns, conflicts with user decisions). Each later arc gets its own short pass when it starts.
- The plan is one markdown document in the plan home that `fr seats` prints on its `Plans:` line: `docs/plans/` in the repository by default, or the service the user names with `plans` in the config file, reached through the host's MCP connector. Keep one copy.
- The user's directional answers go in the plan's Decisions section. When a PR's workstream is created, record the ones that bind it with `fr decide`; reviewers read their brief, not the plan.

### TRR

- Tabula Rasa Review is an informational pass, not a Field Report kind. It does not use `fr review brief`, `record`, or `gate`. Do not mint unused delegations.
- The user says `TRR`, alone or with final MRR. On a long-lived or complex PR (10+ commits or thousands of lines are examples; size is a proxy), the owner may suggest TRR, then wait. Do not auto-run from a threshold.
- When the user asks for TRR, launch three fresh agents using each seat's default model from `fr seats` and the same launch recipes. Fetch origin first. Inspect with `git diff --no-ext-diff --no-textconv <base> <head> --`. Do not commission MRR because the user asked for TRR. If they also asked for final MRR, launch both panels in parallel.
- Do not pass the owner conversation, MRR findings, court packets, or how the workstream arrived here. Do not redo correctness, tests, or security except where they exist only to support unjustified machinery. Answer only the slash questions. Write the prompt to a file; return prose, not a JSON envelope.
- Present the three writeups in a separate **Tabula Rasa Review** section. If an MRR panel also ran, present TRR in addition to it. Each writeup must propose whether the simpler shape can stay on this branch or calls for a rebuild. Cuts the user accepts on this branch become a new head plus CRR. A rebuild the user accepts is a user product decision, not a Field Report READY input. Keep-as-is is also a user product decision.
- Owner prompt template:

```
Independently assess this exact diff as if you had never seen the workstream, owner conversation, or prior reviews. Claim is context, not a product contract. Inspect with: git diff --no-ext-diff --no-textconv <base> <head> --
Do not review correctness, tests, or security except where they exist only to support unjustified machinery.
1. Is any of this overengineering, or variance in product assumptions the user did not specify or request?
2. Is this the simplest possible shape of implementation?
3. If you came into this in a vacuum, what would you slash / simplify / streamline, where the juice is not worth the squeeze, or a product decision is unnecessary and adds cruft or layers of logic that are not justified?
4. For that simpler shape: stay on this branch, or rebuild? Say which, and why. Stay on this branch only if the current commits can be edited into that shape. Call for a rebuild if the accumulated mechanism should be discarded and started over.
Separate blockers-to-slash from optional taste. Do not invent product decisions.
```

### After a pull request is open

- Watch GitHub checks. Flake vs real failure is owner judgment. If it is on the border, consult one seated model (`fr seats`) once before deciding whether to address it. That consult is not a hard gate.
- Fix-and-push still uses CRR. Do not restart MRR because HEAD moved. Wait until the user asks for final MRR.
- Bot comments are owner triage, not a new persona panel, and none is skipped. Whenever a review bot posts, fix each comment, or reply on its thread with why not, then resolve the thread. A thread with any comment from a person, including a reply in a bot's thread, is theirs to resolve: fix it or reply, then leave it for them; do not resolve it to clear the gate. After opening a PR, wait for its review bots. Some bots review every push; others review only on open or on request (Codex: comment `@codex review`). A bot that has not posted yet leaves no thread, so the gate cannot see it; waiting is the owner's job.
- If `main` moves and the PR head did not, do not redo MRR. If merge or rebase changes the head, that is a new HEAD; still wait for the user to ask for final MRR.

### Review envelope

- Every review records its exact delegation, claim, reviewer task or provider run, target, independence, verdict, findings, summary, and explanatory scores. MRR reviews also record unresolved items, structural signals, and simpler-path reasoning. MRR reviews also record the valid list their brief pinned; launch route is provenance. A reviewer-supplied provider is ignored and does not fail the review. CRR records the model id from the brief. The submitted source text stays unchanged.
- Each newly recorded review retains the exact submitted source text alongside the validated result, so deleting the temporary output file does not erase the submitted evidence. Older records lack this source. This is an audit record of what the owner submitted, not proof that the owner did not edit it before submission. Submit the original output; never change verdicts, findings, limitations, completion claims, or provenance. `pass` is not a GO.
- Persona briefs pin their seat's valid list, and recorded evidence retains it. Editing the config file governs new briefs only. Upgrading to seat lists is a hard cut: review evidence recorded before it is discarded, not migrated. Delete the `reviews`, `delegations`, and `waivers` folders under the state root (`~/.local/state/field-report`, or `FIELD_REPORT_STATE_ROOT`), then rerun MRR on open workstreams.
- The delivery claim is a dedicated workstream field (`fr update <id> --claim`). Changing the claim makes prior MRR evidence stale; ordinary summary updates do not.
- Field Report assigns IDs only to MRR findings and unresolved items. CRR findings never get IDs.
- Reviewers put product choices the user has not settled in `questions`. A question alone is not a NO_GO; the owner takes it to the user and records the answer with `fr decide`.
- Required scores are merge readiness, structural risk, implementation quality, evidence confidence, and outcome confidence.

## Repository coordinator

- When AF is installed, name this session into the repo namespace with `fr identity --role coordinator` and AF save (example: `aon/coordinator`); without AF, skip naming. Assign workstreams to owner sessions (named in that namespace when AF is installed). `fr project list` shows each project's todo tracker without a branch-bound workstream. Field Report stores the binding; the project's tracker stores the todos.
- Maintain outcome ownership, sequencing, collision awareness, and MRR/bots visibility. Do not become a second issue tracker. TRR is owner-commissioned when the user asks; coordinators do not launch it.
- When the user explicitly asks for an agent they will work with directly, create a user-owned task. Use an internal subagent only for delegated work the current task will consume.
- Do not answer product or workstream architecture questions for the user. Send those to the user; do not infer them from the repo.

## Workstream owner

- Name this session with `fr identity --role owner` if unnamed. Own the stated outcome. Choose a coherent, reviewable delivery unit and state exactly what it claims.
- Use judgment. Bring product and domain uncertainty to the user before implementing. If the answer would shape data modeling or a one-way decision, stop; do not guess from schema or code. Catch overengineering.
- Keep one implementation owner for the current unit. Launch implementation workers as fresh subagents with a bounded slice and no owner conversation. Do not dispatch a worker to settle a product or domain question. Verify their work. Do not mint a second FR todo or completion ceremony for that; the project's tracker is the ledger.
- Keep a one-line next action with `fr update <id> --next`. Update it when you stop or the next step changes. It is a sticky note, not a todo ledger. The project's tracker holds the todos.
- CRR before you run `git commit` on a commit you intend to keep. A green checkout hook is not CRR. WIP and amend are owner judgment. MRR before opening a PR. After that, CRR through churn. Final MRR only when the user asks; argue substantiveness if it seems unnecessary, then wait. When the user asks for TRR, or agrees after you suggest it on a long or complex PR, launch the three TRR agents and present the writeups separately, including each agent's stay-on-this-branch vs rebuild call. Do not record them. Do not commission MRR because of TRR. If they also asked for final MRR, run both in parallel. Reviews never require permission. Launch each seat's default model, then the seat's next listed model if the default cannot start. Repair or resume a started hang. Do not record provider failure and do not shop after a NO_GO. Fix real findings on a new head and rerun only that seat. Weigh findings by likelihood and blast radius: bring an unlikely, fail-safe finding to the user to accept instead of building machinery for it.
- Do not auto-open a pull request. After `fr gate open` is READY, you may open one or leave that to the user. Never merge.
- Summarize stored MRR evidence clearly, leading with anything that needs attention.

## Reviewer

- Remain read-only. Do not use MCP servers or AF. Do not save an AF name.
- Inspect the exact target with the brief's `inspection.command`. Do not inherit owner conversation or run owner skills.
- CRR stays short: competence and gaps. MRR inspects the complete changed authority boundary; the stated claim is context, not a scope limit.
- Attempt to falsify the candidate; do not defer to the owner's framing, passing tests, implementation effort, or other reviewers. Findings are defects that should block the candidate; weigh likelihood and blast radius, and put unlikely fail-safe edges in the summary.
- If your brief lists this seat's open findings from an earlier head, check each against the current target; any that remain are findings again. Put product choices the user has not settled in `questions`, not findings, and do not pick an answer.
- Separate other risks, observations, and future work from blockers. Return a complete envelope. Do not convert partial evidence into a GO. Omit routing fields rather than guessing them; FR supplies them from the brief and binding. Conflicting model, target, or delegation identity needs correction by the same reviewer on the same delegation. Missing required inspection is adverse evidence, not a formatting problem.

## What not to rebuild

These are swings this program already made. Do not take them again.

- Do not grow Field Report back into a portfolio OS: session aliases, `fr catchup` / heartbeat / watch, checkpoints, holds, `fr commit`, in-repo snapshots, or a second issue tracker. A one-line `--next` sticky note is allowed. AF owns people; the project's tracker owns todos. GitHub owns PRs. This repository's `merge-ready-review.md` owns merge quality.
- Do not put a review panel in the git hook, wrap `git commit`, or answer a skipped panel by closing "bypass" paths. That path produced a week of identity-hardening commits and `--no-verify` pressure. The hook stays a branch-binding check.
- Do not collapse MRR into a generic family panel, and do not add mini-review eligibility to skip a persona. Named seats, one deciding review per seat. The config never drops a seat. Do not restore a provider-fail command, named backup menus, or 2-of-3.
- Do not strip scores, exact-head evidence, AF onboarding (best-effort, never a gate), fresh-context workers, user-held product decisions, MRR scope beyond the claim, or adversarial stance. Each of those was deleted in a simplify and had to be restored. Do not put a live GitHub round-trip inside ordinary MRR target derivation. Do not hide scores when a gate is blocked. Do not restore schema v1 migrate.
- Do not hand-rewrite reviewer output to fix schema, turn pass into GO, remove limitations, or replace delegation IDs. Supported formatting is handled by the recorder; resume the same reviewer for corrections that require judgment. Do not restore `claude-aws`, Fable plan-mode, or unrestricted `Bash(git *)`.
- Do not add `fr question`. Product questions go to the user. Do not make coordinators mute relays or factory owners; they assign and sequence in the repo namespace.
- Do not add a user-permission step before reviews.
- Do not add `kind=trr`, `fr gate trr`, or auto LOC/commit detectors. TRR stays an unrecorded informational pass.
- Do not restore court, job occupancy, cross-head finding reconciliation, waivers, or a reviewer duty to NO_GO unsettled product choices. Together they made every MRR round non-convergent: a fix reran all three seats, and nothing but a new head could clear a finding. The user's acceptance and the failing-seat rerun replace them.
- Keep one canonical skill source, with launch recipes in the skill because agents follow `SKILL.md`. Do not maintain host-specific copies, and do not replace the skill with a pointer that nobody reads.
