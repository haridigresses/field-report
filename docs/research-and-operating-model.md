# Multi-agent visibility research and operating model

> Historical pilot research. The current operating decision supersedes AF session and inbox coordination: Field Report stores Codex task UUID aliases, native Codex task channels carry messaging, and AF remains only as the issue list.

## Recommendation

Keep Codex Desktop + Agent Fixes as the control plane for the pilot. No reviewed product provides the same combination of local Bedrock/Mantle Claude sessions, Codex tasks, AF inbox/issues, exact SHA-scoped review gates, and cross-repository program visibility.

HumanLayer is the closest conceptual alternative and is worth a small read-only trial. Vibe Kanban is the closest execution-board alternative. Conductor is the strongest isolated-workspace launcher. None should replace the pilot until it proves it can preserve the existing AF coordination and reviewer protocol.

## Product principles

| Product | Strongest principle | Fit for this workflow | Main gap |
| --- | --- | --- | --- |
| [Conductor](https://www.conductor.build/docs/concepts/parallel-agents) | Independent work gets independent workspaces; implementation/review agents can share one branch workspace | Excellent branch isolation, diff review, tests, PR and merge workflow | Workspace-centric, not a durable cross-repo program arc or AF inbox view |
| [Vibe Kanban](https://www.vibekanban.com/docs/workspaces) | Project → workspace → repository/session, with Running/Idle/Needs Attention and integrated diffs/PRs | Best ready-made execution dashboard; supports multi-repo workspaces and multiple sessions | Would require moving session lifecycle under Vibe Kanban; limited support for custom SHA gates, AF issues, and Mantle routing must be proven |
| [HumanLayer](https://www.humanlayer.dev/) | Tasks group sessions, artifacts, and worktrees; questions/research/design/plan precede implementation | Closest conceptual match for durable arc, decisions, design artifacts, and human review | Opinionated replacement control plane; AF and `claude-aws` compatibility are not established |
| [Devin](https://docs.devin.ai/product-guides/session-insights) | Managed sessions plus retrospective session insights, issue timelines, and efficiency signals | Useful model for session-health analysis and recurring failure detection | Cloud agent/runtime model conflicts with the local Mantle/AF operating model |
| [OpenCode](https://dev.opencode.ai/) | Provider-neutral agent runtime with parallel sessions | Potential execution runtime or reviewer diversity | It is primarily an agent surface, not a cross-repo status and decision system |

Adjacent options:

- [Linear for Agents](https://linear.app/agents) plus GitHub can provide a strong issue → agent → PR surface, but it does not see local AF sessions, held commits, worktrees, or reviewer conversations.
- [GitHub agentic workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows) can automate repository maintenance and PR-centric tasks, but GitHub is too late in this workflow: much of the important state exists before push.
- Orchestratia advertises cross-repo CLI-agent coordination, structured specs, dependencies, and help/failed states. It is directionally relevant but does not yet have enough demonstrated integration depth to displace AF.

## Observed operating pattern

The last seven days contain 668 AF inbox messages: 611 are not linked to an AF issue and only 57 are issue-linked. The dominant pattern is a high-volume coordinator/executor dialogue, not a conventional task board.

Recurring workflow:

1. A repository coordinator assigns a bounded branch or issue arc.
2. The executor plans and asks product/scope questions before implementation.
3. Work proceeds in commit-sized chunks, often held locally.
4. The executor reports a gate with exact validations and asks for sign-off.
5. The coordinator or an orthogonal reviewer issues GO, CONDITIONAL GO, or NO-GO.
6. Only after approval does the executor push or open/update a PR.
7. CI and bot findings can override an earlier sign-off.
8. Review is SHA-scoped; fixes invalidate the prior merge-ready verdict and trigger another review.
9. The repository coordinator sequences merges and watches overlapping files/worktrees across streams.

This means agent status is secondary. The primary objects are branch, gate, reviewed SHA, outstanding decision, collision/dependency, PR, and next action.

## Information hierarchy

Recommended hierarchy:

1. **Needs attention:** decisions owed, held pushes, failed checks, stale ratings, merge-order collisions.
2. **Repository tracks:** one visually segregated lane per repository with coordinator, WIP count, PR/check health, issue count, and worktree hygiene.
3. **Workstream arc:** 2–3 line current-state summary, explicit gate, next action, and exit condition.
4. **Branch assessment:** merge-readiness probability, rebuild-risk probability, assessed SHA, evidence, and age.
5. **Commit-sized chunks:** complete / active / blocked / planned.
6. **Evidence:** linked PR checks, AF issues, agent liveness, and recent structured AF messages.
7. **Raw session/inbox detail:** drill-down only.

Do not put a live agent grid above the decision queue. A running agent is not progress; a cleared gate or answered decision is progress.

## Additional questions and metrics

### Attention and flow

- What decision is waiting on the user, and for how long?
- What is held locally and cannot be reconstructed from GitHub?
- Which branch is waiting for coordinator sign-off, CI, bots, reviewer reconciliation, or merge order?
- How many NO-GO/re-review cycles has this branch had?
- How long has the branch spent at its current gate?
- What is the next irreversible action?

### Branch and review health

- Assessed SHA versus current SHA.
- Ahead/behind target branch and conflict state.
- Merge-readiness and structural-rebuild risk with evidence.
- Reviewer disagreement: converged, divergent, or not yet reconciled.
- Tests/checks green, pending, failing, skipped, or not run.
- PR chunk coverage: which planned chunks are in which PR, and which are unassigned.

### Program topology

- Merge-order dependency graph between active branches.
- File/zone collision warnings between active worktrees.
- Work-in-progress count per repository and coordinator.
- Active versus stale AF issues; issue-to-inbox linkage ratio.
- Worktree count, prunable worktrees, dirty roots, and disk-risk indicator.

### Session quality

- Repeated environment failures or retries.
- Number of user/coordinator corrections per completed stream.
- Work abandoned or rebuilt after late structural findings.
- Time from kickoff → local green → approved push → merged.

## AF integration

Use AF for issues, sessions, lineage, delegation, wakeups, and message transport. Stable workstream IDs and PR numbers belong in AF issue bodies so deterministic correlation remains possible. AF messages do not mutate Field Report outcome status, questions, or reviewer judgment.

Completed judgment is published directly to the exact-SHA Field Report ledger with `fr pass record`. One in-progress AF issue remains the executor's current focus; backlog issues stay open but visually separate. Session liveness is diagnostic evidence, not a progress metric.

## Monitoring

Prefer deterministic collectors for AF issues, Git, GitHub, CI, and worktree state. Do not spend model calls polling facts that shell or CLI tools can report exactly. Semantic state remains explicitly curated by the repository coordinator or workstream orchestrator; task heartbeats are temporary and only needed while an active agent requires responsiveness.

## Visual forms worth adding

- **Repository lanes:** the primary view, implemented now.
- **Since last visit:** a compact delta list from the most recent snapshot viewed by the user.
- **Gate timeline:** kickoff → local green → sign-off → pushed → CI/bots → merge-ready → merged.
- **Dependency graph:** only when two or more active branches have merge order or file/zone collisions.
- **Aging view:** decisions, held commits, and stale ratings ordered by age.

Avoid decorative agent org charts and raw transcript timelines. They create activity visibility without decision visibility.

## Pilot exit criteria

The system is operational when:

- all active branches appear under the correct repository;
- summaries and chunks match current AF/GitHub evidence;
- every open decision is visible;
- PR and check state refreshes without manual data entry;
- reviewer ratings arrive through AF and become stale on SHA change;
- agent liveness and worktree hygiene are visible;
- returning after 12–24 hours requires no transcript reading to understand the next action.

The remaining material gap is automated narrative/chunk reconciliation. Structured AF status messages now update live status, but checklist changes are still curated. The next implementation should add a since-last-visit delta and an event-triggered repository steward, not another continuously running agent.
