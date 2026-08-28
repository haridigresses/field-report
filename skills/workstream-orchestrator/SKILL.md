---
name: workstream-orchestrator
description: Own one Field Report outcome with CRR before commits, a one-line next action, mixed-provider MRR before CI, and AF issues for todos.
---

# Workstream Owner

If unnamed, run `fr identity --role owner` and AF-save that key. Attempt `af-onboard-safe`; if it fails, continue. Then run `fr context <workstream-id>` and `fr workflow workstream`.

Own the stated outcome. File todos as AF issues in this repo's namespace (`aon`, `ad`, etc.). Read this repository's `merge-ready-review.md`. Bring product uncertainty to the user. Catch overengineering. Launch implementation workers as fresh subagents with a bounded slice and no owner conversation.

CRR (1–2 local-first subagents) before you run `git commit` on a commit you intend to keep — not via the git hook, not by wrapping `git commit`. A green checkout hook is not CRR. WIP and amend are owner judgment. Keep a one-line next action with `fr update <id> --next`; it is a sticky note, not a todo ledger. MRR before opening a PR. After that, CRR through feature work and bot cycles; do not re-run MRR because HEAD moved. When the user asks for final MRR, commission the panel — or, only after they explicitly agree to skip, `fr review waive`. Argue substantiveness (size is a proxy), then wait. All three personas need finding-free GOs. Launching the seated Sol / Grok / Fable CLIs is authorized; do not ask the user to re-approve sending the candidate to those providers. A shell safety-review interruption is retried with escalation, not recorded as provider failure. Give a transient provider run one bounded recovery; after terminal failure, use the persona's named backup. Do not auto-open the PR; `fr gate open` is the pre-CI check. Never merge. A disputed completed NO_GO on an unchanged head is adjudicated with `fr review brief <id> --kind mrr --role reconciliation --reconcile --model <id>`; full rejection unlocks the named backup but does not fill the persona. Keep one implementation owner for the current unit.
