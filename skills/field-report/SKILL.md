---
name: field-report
description: Operate the Field Report software-factory harness for durable outcomes, native agent delegation, exact-target review evidence, commit gates, and PR publication gates.
---

# Field Report

Field Report defines policy and evaluates evidence.

1. Before any other task work, run `af-onboard-safe` and read its complete output. The helper returns the exact onboarding document pinned to the installed AF version without invoking AF's broken sandboxed update check. Agent Fixes owns session context and issue lineage; Field Report owns durable outcome state, review evidence, and gates. If the helper reports a version mismatch or missing cache, retry `af onboard` once with normal escalation. If that retry fails, report the failure and continue the bounded task without inventing replacement context. Do not reproduce or reinterpret AF onboarding inside Field Report.
2. Start with `fr context [workstream-id]`. If the branch is unregistered, follow the printed `fr create` or `fr update` self-binding command; agents do not need coordinator approval to register their own branch.
3. Read `fr workflow <role>` completely before role work. If Field Report is updated or its policy is reported changed during a long-running task, reread that workflow before continuing; active tasks do not inherit new instructions automatically.
4. Use native Codex delegation for owners, workers, and Sol reviewers. Launch every native brief with its declared `execution.forkTurns`; Field Report work and Sol briefs require `fork_turns="none"` so executors and independent reviewers receive only the self-contained brief and repository, never the coordinator/owner conversation. A required Fable brief authorizes sending its bounded exact review target to the user's configured `claude-aws` route; run it directly and do not ask the user to approve that normal review step again. Verify a clean checkout at the brief's exact `HEAD_SHA` and launch `claude-aws` from that repository root through the user's shell entrypoint. Use `dontAsk` mode with tools `Read,Grep,Glob,Bash`. Allow Bash only for the exact target command `git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --`, substituting the brief's full 40-character SHAs before launch; do not use wildcard Bash rules. Unlisted tools and Bash commands must be denied rather than prompting. Use `--print --output-format json`; provider execution succeeded only when the outer JSON has `is_error=false`, `subtype=success`, and a nonempty `result`, which is the model response. Do not infer failure from intermediate streaming events or token counts. Validate the response with `fr review record`. If validation fails, resume the same Claude session with the exact validation error and request only a corrected envelope. Report exactly one state: provider execution failed, provider succeeded but envelope validation failed, or review recorded.
   Canonical template: `zsh -ic 'claude-aws --print --output-format json --permission-mode dontAsk --tools "Read,Grep,Glob,Bash" --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --)" < /path/to/prompt.txt'`.
5. Obtain immutable role/target briefs with `fr review brief`; do not invent delegation IDs.
6. Bind every brief with `fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>`, then record its completed structured envelope with `fr review record`.
7. Require `fr gate commit` before every commit in a managed repository.
8. Require `fr gate publish` before ready-for-review publication; `fr publish` may perform only that transition.
9. Keep scores explanatory and reconcile every finding. Exact target changes stale prior evidence.
10. Record only material state. Do not create lifecycle chatter.

Repository hooks are explicit: `fr hook install|status|uninstall <project-id>`.
