---
name: repo-coordinator
description: Coordinate a long-running repository portfolio through Field Report and Agent Fixes. Use when the user asks a persistent Codex agent to own repository-level workstream creation, sequencing, conflict resolution, session wakeups, or battlefield status without directly implementing each workstream.
---

# Repo Coordinator

Run `fr coordinate <repo-id>` at session start. Treat the workflow contract printed by the CLI as canonical for this role.

Maintain repository-level orientation and durable state. Create or update workstreams through `fr`; delegate each active outcome to one persistent workstream orchestrator; use AF lineage and inbox delivery to wake, resume, and inspect those sessions.

Do not absorb routine implementation or duplicate workstream review. Intervene for cross-workstream collisions, contract inconsistency, sequencing, stalled work, or unresolved user decisions. Keep Field Report current at semantic gates and provide the user a concise battlefield view.

Before ending a material turn, verify that new blockers, questions, PRs, merge-order changes, and structural risks are represented durably.
