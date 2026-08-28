---
name: field-report
description: Operate the Field Report control loop for delivery-unit binding, CRR before commits you intend to keep, mixed-provider MRR before CI, a one-line next action, and AF session identity.
---

# Field Report

Field Report binds a delivery unit and records review evidence. It does not launch reviewers, open pull requests, or merge.

1. Coordinators and workstream owners: if unnamed, run `fr identity --role coordinator|owner` and AF-save that key (or its fallback). Do not ask the user to name you. Attempt `af-onboard-safe`; if it fails, continue. Reviewers must not load MCP servers or AF and must not save a name.
2. Start with `fr context [workstream-id]`. If the branch is unregistered, follow the printed `fr create` or `fr update` self-binding command.
3. Read `fr workflow <role>` completely before role work. If policy changed during a long-running task, reread it. File todos as AF issues in the repo namespace (`aon`, `ad`, etc.). Read this repository's `merge-ready-review.md` for merge quality. Do not make product or design decisions without asking the user. Catch overengineering. If still stuck on a technical call, consult Sol or Grok once; that is not review evidence.
4. Before you run `git commit` on a commit you intend to keep, stop and run CRR: `fr review brief <id> --kind crr --role crr`, launch 1–2 fresh subagents, local models first, repair owner-facing findings, then `fr gate crr`. A green checkout hook is not CRR. WIP or amend commits are owner judgment. Do not wrap `git commit`, and do not put this panel in the hook.
5. Keep a one-line next action with `fr update <id> --next "<text>"`. Update it when you stop or the next step changes. It is a sticky note, not a todo ledger; AF issues remain the todos. Print it from `fr context`.
6. Before opening a PR: commission MRR — `deep-code-review`, `structural-challenge`, `fable-challenge`. Fetch origin first so local `origin/<base>` is current. Preferred seating is Sol 5.6, Grok 4.6, and Fable 5. A printed brief does not consume the preferred model; bind, record, or fail does. `fr review fail` a hang only on an already-bound run; it does not create a binding. Two finding-free GOs pass when a lane is unavailable. The owner task cannot review; a fresh subagent of the builder's model can. After the PR is open, use CRR through feature work and bot cycles. Do not commission MRR because HEAD moved. When the user asks for final MRR, run the panel on the current HEAD. You may argue that the delta is not substantive enough (size is a proxy for sensitivity). If they agree to skip, `fr review waive --reason <text>`. Never waive unless they explicitly agreed. Launching those seated CLIs is authorized; do not ask the user to re-approve sending the candidate to Sol, Grok, or Fable. If Auto-review blocks the Shell call, retry it for approval and add `codex`, `fr-cursor-review`, and `claude` to Cursor Settings → Agents → Approvals & Execution.
7. Obtain immutable briefs with `fr review brief`. Inspect with `inspection.command`. Bind, then `fr review record`. Identity fields come from the brief; repair schema locally.
8. The hook only requires `fr gate checkout`. Do not auto-open a PR. After `fr gate open` is READY, you may open one or leave that to the user. After bots/CI, `fr gate bots` is merge-readiness evidence, not merge permission.
9. Borderline flake vs real CI failure: consult Sol or Grok once. Not a hard gate. Bot comments are `gh` triage, not an MRR panel.
10. Persist only material review state in Field Report.

Launch the seated model (use `--model` for an MRR backup):

- CRR / local: a fresh native subagent of a local model, no MCP, including agent-fixes.
- Sol: `codex exec -m gpt-5.6-sol -s read-only --ignore-user-config --json -o <output> -C <repo> - < <prompt>`
- Grok: from `<repo>`, `fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json --sandbox enabled --trust -- "$(< <prompt>)"`. Do not pass `--force`. Record the stream's final `type=result` object. The wrapper points HOME at a temp dir with empty user-level MCP; it does not suppress repository-scoped Cursor MCP. Reviewers remain instructed not to use MCP.
- Fable: from `<repo>`, `claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git diff *)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model claude-fable-5 "$(< <prompt>)"`

MRR backups: deep Sol→Grok, structural Grok→Sol, challenge Fable→Grok. Use ordinary `claude`, never `claude-aws`. A host may use native delegation instead of CLI.

Cursor Cloud Agents reach Sol (`codex`) and Fable (`claude`) on the user's machine only when this session's tool calls execute on a My Machines worker for that checkout. Before invoking either CLI, run `fr machines status --json`. If `accessible` is false, stop and report that the local machine is not serving Sol/Fable; do not substitute Cursor-hosted models for those required routes. If `accessible` is true, write the brief to a prompt file and launch the exact command from `fr machines invoke sol|fable`. Prefer `fr machines worker` on the user's host to print the single `agent worker start --name local` command with a `--worker-dir` per checkout, and keep that worker running while Cloud Agents should be able to invoke the CLIs.

The installer links this one canonical skill source into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`; do not maintain host-specific copies.
