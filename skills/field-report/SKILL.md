---
name: field-report
description: Maintain Field Report workstreams with the fr CLI. Use when the user says Field Report, fr, track this work, create a workstream, record a question or decision, reconcile a workstream, update the portfolio, request an assessment, checkpoint progress, or keep an orchestrator session synchronized with durable outcome state.
---

# Field Report

Use `fr` instead of editing Field Report JSON or composing AF protocol messages manually.

## Start

Run `fr status`. If unarmed:

- Run `fr auto-onboard` when the current branch already belongs to a workstream.
- Run `fr onboard <id> --role orchestrator|reviewer|executor` when the ID is known.
- Run `fr create ...` when the user asks to track a new durable outcome.

After arming, speak normally with the user. Do not expose routing syntax unless debugging.

Use `fr watch start` when the user wants autonomous, rate-limited Field Report nudges while the service is running. Use `fr watch stop` to disable them.

## Record durable state

- Situation or gate changed: `fr checkpoint --summary "..." --status active --gate "..." --note "..."`
- Full consistency pass: `fr reconcile --data '<json patch>' --note "..."`
- Durable question: `fr ask "..."`
- Decision: `fr decide Q1 "..."`
- Reviewer judgment: `fr assess`
- End of assignment: reconcile material changes, then `fr disarm`.

Use `fr show --json` before a broad reconciliation. Keep summaries to the outcome, current phase or gate, and next milestone or blocker. Keep milestones commit-sized or independently verifiable, not micro-task-sized.

## Update autonomously

Checkpoint at material gates: meaningful commit, push, PR creation, review verdict, blocker change, AF issue resolution, question resolution, or session end. Skip ordinary tool use and implementation chatter. When a Field Report nudge arrives, reconcile the delta against current evidence before publishing.

## Authority

- Orchestrators may update situation, status, milestones, PR associations, questions, and next gate.
- Reviewers own outcome confidence, merge readiness, necessity, simplification, and structural rebuild risk.
- Never silently change the durable outcome or accept material scope expansion. Record it as a question or proposal for the user.
- Preserve history; correct stale state with a new checkpoint rather than rewriting past events.

Run `fr help` for command syntax.
