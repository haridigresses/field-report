---
name: field-report
description: Maintain Field Report workstreams with the fr CLI. Use when the user says Field Report, fr, track this work, create a workstream, record a question or decision, reconcile a workstream, update the portfolio, request an assessment, checkpoint progress, or keep an orchestrator session synchronized with durable outcome state.
---

# Field Report

Use `fr` instead of editing Field Report JSON. The CLI writes canonical state locally without requiring the dashboard server. `docs/fr-workflow.md`, delivered through `fr workflow`, is the single normative behavior contract; this skill only explains how to operate the CLI.

## Orient and arm

Start with `fr status`. Then use the narrowest entry point:

- `fr context` for checkout-aware orientation.
- `fr auto-onboard` when the current branch already maps to a workstream.
- `fr coordinate <repo-id>` for a persistent repository coordinator.
- `fr onboard <id> --role workstream-orchestrator|reviewer|executor` for a known workstream.
- `fr create ...` only when the user asks to track a new durable outcome.

Arming must return the Shared and active-role workflow contract. Read it before role actions; if it is unavailable, do not mutate role-owned state. Run `fr workflow` again after compaction. Repository coordinators use `fr catchup` when resuming or before portfolio decisions.

Register a short global alias with `fr session alias <alias> [--id <task-uuid>]` and assign it with `fr assign <workstream-id> --session <alias-or-uuid>`. Previous aliases remain fallbacks. Mirror the primary alias to the Codex sidebar when task-title management is available; UUID identity remains authoritative.

## Record durable state

- Situation or gate changed: `fr checkpoint --summary "..." --status active --gate "..." --note "..."`
- Full consistency pass: `fr reconcile --data '<json patch>' --note "..."`
- Durable question: `fr ask "..."`
- Decision: `fr decide Q1 "..."`
- Execution evidence: `fr link issue <issue-id>` and `fr link commit <sha> --chunk <milestone-id>`.
- Governing git context: `fr reference --path <repo-relative-path> --kind plan|contract|decision|review --quote "<short exact excerpt>"`.
- Prepare non-gating advisory judgment with `fr assess <id>` and deliver the brief through native Codex task tooling.
- For MRR, start a separate role-specific review with truthful model/provider provenance, then let that reviewer record completed evidence with `fr pass record ...` or `fr pass import ...`.
- Full MRR for a Field Report-managed code project requires at least two distinct registered native Sol reviewer tasks and at least one completed Fable review through the verified `claude-aws` route on the exact head. Run Fable only with `fr pass run-fable <id> --head <sha> --prompt-file <review-prompt> --evidence-file <new-raw-stream-jsonl>` so Field Report derives and packets the full `origin/main` branch diff before launching the read-only reviewer; generic pass import cannot mint Fable provenance.
- Check the active gate with `fr mrr [id]`.
- Before every commit, have two distinct Sol reviewer tasks record fresh base-and-staged-tree lanes with `fr commit-review record ... --model <sol-model>`, then commit through `fr commit [id] --message "..."`.
- Use `fr hold [id] --reason "..."` and `fr unhold [id]` for publication blockers outside MRR.
- Before marking a GitHub PR non-draft or ready, require `fr release-check [id]`. Branch pushes and draft PRs may precede MRR so remote evidence can run; non-draft publication may not.

Use `fr show --json` before broad reconciliation. Let `fr checkpoint` infer checkout branch/head evidence; use `fr link commit` only for distinct chunk evidence. Link only git documents that materially constrain scope or contracts. Use `fr watch --once` for outcomes needing native follow-up.

At assignment end, reconcile material changes and run `fr disarm`. Run `fr help` for full syntax.
