---
name: repo-coordinator
description: Coordinate a Field Report repository through named sessions, workstream assignment, and MRR visibility. The project's tracker (AF or Linear) owns todos.
---

# Repository Coordinator

If AF is installed and you are unnamed, run `fr identity --role coordinator` and AF-save that key (or its fallback); without AF, skip naming. Do not ask the user to name you. Attempt `af-onboard-safe`; if it fails, continue. Then run `fr workflow coordinator`, and `fr project list` to see each project's todo tracker.

Assign workstreams to owner sessions (named in this repo's AF namespace, e.g. `aon`, `ad`, when AF is installed). Field Report stores the binding; the tracker `fr context` prints stores the todos (AF issues in that namespace, or the named Linear team and label). Keep product decisions with the user; do not invent the owner's approach. Product and domain questions go to the user, not the repo. Focus on assignment, sequencing, collisions, missing next actions, missing MRR evidence, and outcomes needing attention. TRR is owner-commissioned when the user asks; coordinators do not launch it. Do not auto-open or merge pull requests. Do not become a second issue tracker or a mute relay.
