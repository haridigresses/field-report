---
name: brr
description: Build-ready review for work that spans several pull requests. Sketch the arcs, scan each for landmines, settle the directional calls with the user, and get sign-off on a short plan before building. Use when the user asks for a BRR or a plan for multi-PR work; not for a single PR.
---

# Build-ready review (BRR)

BRR gets directional sign-off on a multi-PR build without designing all of it up front. Only the arc that starts now is planned in detail. Later arcs get just enough investigation to know they hold no landmines, and get their own short pass when they start.

The user's sign-off is the only gate. BRR has no seats, no verdict, and nothing recorded as review evidence.

## 1. Clarify

Run `fr-ask-questions` on the request: the outcome, what done looks like for the whole build, and what is out of scope. Ask only what reading the repo cannot answer.

## 2. Look before proposing

Read-only, as in plan mode: read the relevant code and docs, prior user decisions in the conversation or existing plans, and this repository's architecture and footgun docs. Cite files. Change nothing, and write no code.

## 3. Sketch the arcs

- **Outcome and non-goals.** One or two sentences each. Non-goals guard against scope creep.
- **Is this needed, and what is the smallest version?** Include "do nothing" or "one PR and a follow-up" when either is plausible.
- **Approach.** Recommend one, with its tradeoffs (maintenance cost, reversibility, what it locks in). Name alternatives only when they are real.
- **Arcs.** Each arc ends in something the user can use or see. Give each one what it delivers, a rough size in PRs, and what it depends on. Under about 8 PRs, a single arc is fine.
- **The first arc only, as PRs.** Each PR can merge to main on its own and leaves main working. Give each a one-line claim, the check that proves it is done, and the doc section it implements. Mark which PRs can run in parallel without touching the same files. Do not stack PRs across arcs.

## 4. Scan each arc for landmines

For every arc, investigate only enough to answer "is there a landmine here?":

- one-way decisions: schema, migrations, shared tables or contracts, auth boundaries, public APIs;
- feasibility unknowns: "can we even do this";
- conflicts with decisions the user already made.

Report each arc as "no landmines found" or name the landmine. Where one is uncertain, propose a spike: the question it answers, a timebox, and the decision it feeds. Spikes are throwaway. Put the riskiest one-way decisions and spikes as early as the order allows. Do not design later arcs.

## 5. State assumptions plainly

List every assumption the plan rests on, including ones implied earlier in the conversation. For each, give where it came from (stated by the user, inferred from code, or inferred from the conversation) and what changes if it is wrong. Only the user turns an assumption into a decision.

## 6. Settle the directional calls

Use `fr-grill-me` on the open directional choices, one question at a time with a recommended answer. Write each answer in the plan's Decisions section. Pass `--brr <plan-file>` (or place the plan in `docs/plans/` where `fr mrr` auto-detects it) so the `intent` seat treats the signed-off BRR plan as authoritative.

## 7. Write the plan and get sign-off

Write the plan as plain markdown in the project's plan home (`fr status` and `fr project list` show it). If that is `docs/plans/`, write `docs/plans/<build>.md` in the target repository. If it names a service (Linear, Notion, or Ref) and a reference, write and read the plan there through this host's MCP connector for it. If the host has no connector for it, say so and ask the user where to put the plan; do not silently write it somewhere else.

Keep one copy. The plan home holds the plan and the user's comments; do not keep a second copy in the repo that can drift.

Use this outline: outcome; non-goals; the recommended approach; arcs (first arc as PRs); landmines and spikes; assumptions; decisions. Then stop and wait for the user's sign-off. Build nothing before it.

## Later arcs

When an arc starts, read the user's comments on the plan, then repeat steps 2, 4 and 6 for that arc alone and break it into PRs. If a PR shows the plan is wrong, update the plan and tell the user before continuing.
