---
name: field-report
description: Operate the Field Report software-factory harness for durable outcomes, agent delegation, exact-target review evidence, commit gates, and PR publication gates.
---

# Field Report

Field Report defines policy and evaluates evidence. It does not launch reviewers.

1. Attempt `af-onboard-safe` for useful context. If it is unavailable or fails, report that briefly and continue; AF never blocks work or review.
2. Start with `fr context [workstream-id]`. If the branch is unregistered, follow the printed `fr create` or `fr update` self-binding command; agents do not need coordinator approval to register their own branch.
3. Read `fr workflow <role>` completely before role work. If Field Report is updated or its policy is reported changed during a long-running task, reread that workflow before continuing; active tasks do not inherit new instructions automatically.
4. Commission Codex, Cursor, and Claude briefs for every exact target. Use native delegation for the current host's own family and that provider's installed CLI for the other two. Do not pass the owner conversation; each reviewer gets only its brief and repository. Models are not hardcoded.
5. Obtain immutable briefs with `fr review brief <id> --kind commit|final --reviewer codex|cursor|claude --route native|cli`; do not invent delegation IDs. Inspect with `inspection.command`. Use `--reconcile` only for a lane intentionally checking delivered finding IDs.
6. Bind every brief, then record a valid envelope with `fr review record`. If the provider attempt cannot produce valid evidence, terminate it with `fr review fail`; do not turn failure into a verdict. All three attempts must terminate, two completed finding-free GOs are required, and any completed adverse evidence blocks.
7. Require `fr gate commit` before every commit in a managed repository.
8. Require `fr gate publish` before ready-for-review publication; `fr publish` may perform only that transition.
9. Keep scores explanatory and reconcile every finding. Exact target changes stale prior evidence.
10. Persist only material state in Field Report.

Launch templates for non-native families (use the provider's configured default model):

- Codex: `codex exec -s read-only --ignore-user-config --ephemeral --json -o <output> -C <repo> - < <prompt>`
- Cursor: from `<repo>`, `cursor-agent --print --output-format json --sandbox enabled --trust --auto-review "$(< <prompt>)"`
- Claude: from `<repo>`, `claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash" --output-format json --no-session-persistence "$(< <prompt>)"`

These are launch guidance, not provider policy. A host may use its own native delegation instead, and the envelope records the actual model and `native|cli` route.

The installer links this one canonical skill source into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`; do not maintain host-specific copies. Use ordinary `claude`, never `claude-aws`, for new Claude delegation and review evidence.

Repository hooks are explicit: `fr hook install|status|uninstall <project-id>`.
