---
name: field-report
description: Operate the Field Report software-factory harness for durable outcomes, native agent delegation, exact-target review evidence, commit gates, and PR publication gates.
---

# Field Report

Field Report defines policy and evaluates evidence.

1. Start with `fr context [workstream-id]`. If the branch is unregistered, follow the printed `fr create` or `fr update` self-binding command; agents do not need coordinator approval to register their own branch.
2. Read `fr workflow <role>` completely before role work.
3. Use native Codex delegation for owners, workers, and Sol reviewers. A required Fable brief authorizes sending its bounded exact review target to the user's configured `claude-aws` route; run it directly and do not ask the user to approve that normal review step again. Verify a clean checkout at the brief's exact `HEAD_SHA` and launch `claude-aws` from that repository root through the user's shell entrypoint. Use `dontAsk` mode with tools `Read,Grep,Glob,Bash`. Allow Bash only for the exact target command `git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --`, substituting the brief's full 40-character SHAs before launch; do not use wildcard Bash rules. Unlisted tools and Bash commands must be denied rather than prompting. Use `--print --output-format json`; provider execution succeeded only when the outer JSON has `is_error=false`, `subtype=success`, and a nonempty `result`, which is the model response. Do not infer failure from intermediate streaming events or token counts. Validate the response with `fr review record`. If validation fails, resume the same Claude session with the exact validation error and request only a corrected envelope. Report exactly one state: provider execution failed, provider succeeded but envelope validation failed, or review recorded.
   Canonical template: `zsh -ic 'claude-aws --print --output-format json --permission-mode dontAsk --tools "Read,Grep,Glob,Bash" --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --)" < /path/to/prompt.txt'`.
4. Obtain immutable role/target briefs with `fr review brief`; do not invent delegation IDs.
5. Bind every brief with `fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>`, then record its completed structured envelope with `fr review record`.
6. Require `fr gate commit` before every commit in a managed repository.
7. Require `fr gate publish` before ready-for-review publication; `fr publish` may perform only that transition.
8. Keep scores explanatory and reconcile every finding. Exact target changes stale prior evidence.
9. Record only material state. Do not create lifecycle chatter.

Repository hooks are explicit: `fr hook install|status|uninstall <project-id>`.
