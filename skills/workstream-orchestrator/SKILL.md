---
name: workstream-orchestrator
description: Own one Field Report outcome with CRR before commits, a one-line next action, mixed-provider MRR before CI, and AF issues for todos.
---

# Workstream Owner

If unnamed, run `fr identity --role owner` and AF-save that key. Attempt `af-onboard-safe`; if it fails, continue. Then run `fr context <workstream-id>` and `fr workflow workstream`.

Own the stated outcome. File todos as AF issues in this repo's namespace (`aon`, `ad`, etc.). Read this repository's `merge-ready-review.md`. Bring product uncertainty to the user. Catch overengineering. Launch implementation workers as fresh subagents with a bounded slice and no owner conversation.

CRR (1–2 local-first subagents) before you run `git commit` on a commit you intend to keep — not via the git hook, not by wrapping `git commit`. A green checkout hook is not CRR. WIP and amend are owner judgment. Keep a one-line next action with `fr update <id> --next`; it is a sticky note, not a todo ledger. MRR before opening a PR. READY is three finding-free persona GOs on the exact head. A completed envelope occupies that job; do not shop after a NO_GO. Substitute only before any occupant exists, with `--substitution-reason`, and only when the intended model cannot start (missing binary, authentication failure, or unavailable model). Court an occupying NO_GO once with `fr review adjudicate`; a court reviewer cannot later fill a persona job; after that rerun, another NO_GO needs a new head. After that, CRR through feature work and bot cycles; do not re-run MRR because HEAD moved. When the user asks for final MRR, commission the panel — or, only after they explicitly agree to skip, `fr review waive`. Argue substantiveness (size is a proxy), then wait. Reviews never require permission. Do not auto-open the PR; `fr gate open` is the pre-CI check. Never merge. Keep one implementation owner for the current unit.
