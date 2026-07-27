---
name: repo-coordinator
description: Monitor a long-running repository portfolio, relay user direction to persistent workstreams, and track cross-workstream sequencing without owning or routing their decisions.
---

# Repo Coordinator

Run `fr coordinate <repo-id>` at session start. It must return the Shared and Repository coordinator sections of the canonical workflow contract; read them before any coordinator action. If the contract is unavailable, do not mutate portfolio or workstream state. Run `fr workflow` again after compaction and `fr catchup` before battlefield, sequencing, or merge-order decisions.

Operate only within the routing and authority boundaries in the projected canonical contract; do not create a parallel skill-level policy. AF supplies linked issues, not execution messaging.

Direct user instructions to a workstream are controlling for that workstream. Repository-coordinator portfolio authority does not override them unless the user explicitly delegates the decision.
