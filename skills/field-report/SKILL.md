---
name: field-report
description: Operate the Field Report software-factory harness for durable outcomes, agent delegation, exact-target review evidence, commit gates, and PR publication gates.
---

# Field Report

Field Report defines policy and evaluates evidence. It does not launch reviewers.

1. Coordinators, workstream owners, and executors run `af-onboard-safe` before role work. Bounded reviewers use their self-contained briefs instead of AF onboarding or inherited owner history.
2. Start with `fr context [workstream-id]`. If the branch is unregistered, follow the printed `fr create` or `fr update` self-binding command; agents do not need coordinator approval to register their own branch.
3. Read `fr workflow <role>` completely before role work. If Field Report is updated or its policy is reported changed during a long-running task, reread that workflow before continuing; active tasks do not inherit new instructions automatically.
4. Launch work and review from the brief. Use one of `execution.allowed` with `execution.freshContext`. For Sol via Codex CLI: `codex exec -m gpt-5.6-sol -s read-only --ignore-user-config --json -o <file> -C <repo> - < prompt.txt`. Bind the JSONL `thread.started` thread_id, then record with `fr review record`. Plain JSON, one fenced JSON object, and a successful `claude-aws --output-format json` result (`is_error=false`, `subtype=success`, nonempty `result`) are accepted; the normalized object still has to pass the existing validator.
5. Obtain immutable role/target briefs with `fr review brief`; do not invent delegation IDs. Inspect the target with `inspection.command` from the brief. Do not embed the full diff in a follow-up prompt.
6. Bind every brief with `fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>`, then record it with `fr review record`.
7. Require `fr gate commit` before every commit in a managed repository.
8. Require `fr gate publish` before ready-for-review publication; `fr publish` may perform only that transition.
9. Keep scores explanatory and reconcile every finding. Exact target changes stale prior evidence.
10. Record only material state. Do not create lifecycle chatter.

For required Fable review, launch `claude-aws` from a clean checkout at the brief's exact head. Use `dontAsk` with tools `Read,Grep,Glob,Bash`. Allow Bash only for `inspection.command`. Provider execution succeeded only when the outer JSON has `is_error=false`, `subtype=success`, and a nonempty `result`. If `fr review record` rejects the envelope, resume the same Claude session with the exact validation error.

Repository hooks are explicit: `fr hook install|status|uninstall <project-id>`.
