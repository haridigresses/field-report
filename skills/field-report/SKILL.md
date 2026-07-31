---
name: field-report
description: Operate the Field Report software-factory harness for durable outcomes, native agent delegation, exact-target review evidence, commit gates, and PR publication gates.
---

# Field Report

Field Report defines policy and evaluates evidence. It does not launch Codex, Claude, or provider processes.

1. Start with `fr context [workstream-id]`.
2. Read `fr workflow <role>` completely before role work.
3. Use native Codex delegation for owners, workers, and Sol reviewers. Use the user's configured `claude-aws` route for Fable.
4. Obtain immutable role/target briefs with `fr review brief`; do not invent delegation IDs.
5. Bind every brief with `fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>`, then record its completed structured envelope with `fr review record`.
6. Require `fr gate commit` before every commit in a managed repository.
7. Require `fr gate publish` before ready-for-review publication; `fr publish` may perform only that transition.
8. Keep scores explanatory and reconcile every finding. Exact target changes stale prior evidence.
9. Record only material state. Do not create lifecycle chatter.

Repository hooks are explicit: `fr hook install|status|uninstall <project-id>`.
