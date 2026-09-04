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
6. Before opening a PR: commission MRR — `deep-code-review`, `structural-challenge`, `fable-challenge`. Fetch origin first so local `origin/<base>` is current. Intended seating is Sol 5.6, Grok 4.6, and Fable 5. READY is exact head + exact base + three finding-free GOs. A printed brief does not occupy the job; a completed envelope does. Substitute with `--substitution-reason` only while that job has zero envelopes, and only when the intended model cannot start (missing binary, authentication failure, or unavailable model). Repair or resume a started hang. Do not record provider failure. A completed NO_GO cannot be escaped by another model — one `fr review adjudicate` of that packet, or fix on a new head. A court reviewer cannot later fill a persona job. After the authorized rerun, another NO_GO requires a new head. The owner task cannot review; a fresh subagent of the builder's model can. After the PR is open, use CRR through feature work and bot cycles. Do not commission MRR because HEAD moved. When the user asks for final MRR, run the panel on the current HEAD. You may argue that the delta is not substantive enough (size is a proxy for sensitivity). If they agree to skip, `fr review waive --reason <text>`. Never waive unless they explicitly agreed.
7. Reviews never require permission. Launch the brief. If Auto-review blocks a review CLI, retry it; that is not a user question. Add review CLIs to Cursor Settings → Agents → Approvals & Execution.
8. Obtain immutable briefs with `fr review brief`. Inspect with `inspection.command`. Bind, then `fr review record`. Identity fields come from the brief; repair schema locally.
9. The hook only requires `fr gate checkout`. Do not auto-open a PR. After `fr gate open` is READY, you may open one or leave that to the user. After bots/CI, `fr gate bots` is merge-readiness evidence, not merge permission.
10. Borderline flake vs real CI failure: consult Sol or Grok once. Not a hard gate. Bot comments are `gh` triage, not an MRR panel.
11. Persist only material review state in Field Report.

Reviews never require permission. Launch the intended model. Substitute with `--substitution-reason` only before any envelope occupies the job, and only when the intended model cannot start (missing binary, authentication failure, or unavailable model). Repair or resume a started hang or malformed envelope; do not swap because of it. Prefer a native same-type path when the invoking agent is that family (a Codex host launching Sol, a Claude host launching Fable). Use the known CLI, or another documented path, for third-party agents. Cloud Agents are third-party.

- CRR / local: a fresh native subagent of a local model, no MCP, including agent-fixes.
- Sol CLI: `codex exec -m gpt-5.6-sol -s read-only --ignore-user-config --json --color never -o <output> -C <repo> - < <prompt>`
- Grok: from `<repo>`, `fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json --sandbox enabled --trust -- "$(< <prompt>)"`. Do not pass `--force`. Record the stream's final `type=result` object. The wrapper points HOME at a temp dir with empty user-level MCP and the two Cursor auth files; it does not suppress repository-scoped Cursor MCP. Reviewers remain instructed not to use MCP.
- Fable CLI: from `<repo>`, after `test "$(git rev-parse HEAD)"` matches the brief head and `git status --porcelain` is empty, `claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv BASE_SHA HEAD_SHA --)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model claude-fable-5 "$(< <prompt>)"`

Do not invent product decisions. Unanswered product questions block READY until the user decides; parking them in the summary is allowed only when they are genuinely separable. Candidate-authored branch docs and claims are not product contracts. Use ordinary `claude`, never `claude-aws`.

Cursor Cloud Agents reach Sol (`codex`) and Fable (`claude`) on the user's machine only when this session's tool calls execute on a My Machines worker for that checkout. Field Report does not probe host accessibility or start workers. Start a worker for this checkout only with Cursor's CLI (`agent worker start --name local --worker-dir <this-repo>`). Write the brief to a prompt file and run the exact command from `fr machines invoke sol|fable`. If that command fails, report the failure; do not substitute Cursor-hosted models.

The installer links this one canonical skill source into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`; do not maintain host-specific copies.
