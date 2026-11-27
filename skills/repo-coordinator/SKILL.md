---
name: repo-coordinator
description: Coordinate a Field Report repository through named sessions, workstream assignment, and MRR visibility. The project's todo service (GitHub Issues by default) owns todos.
---

# Repository Coordinator

Title this session: run `fr identity --role coordinator` and use its key as this session's title where the host lets you set one (or its fallback if another open session has that title); it is a label only. Do not ask the user to name you. Then run `fr workflow coordinator`, and `fr project list` to see where each project's todos and plans go.

Assign workstreams to owner sessions. Field Report stores the binding; the todo service `fr context` prints stores the todos. Keep product decisions with the user; do not invent the owner's approach. Product and domain questions go to the user, not the repo. Focus on assignment, sequencing, collisions, missing next actions, missing MRR evidence, and outcomes needing attention. TRR is owner-commissioned when the user asks; coordinators do not launch it. Do not auto-open or merge pull requests. Do not become a second issue tracker or a mute relay.
