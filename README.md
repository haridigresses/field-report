# Field Report

Field Report is a local software-factory policy and evidence harness. It keeps durable outcome state, gives coordinators and workstream owners canonical operating instructions, issues exact-target review briefs, validates completed evidence, and evaluates commit and publication gates.

Field Report defines policy and evaluates evidence. The owner launches Codex, Cursor, and Claude reviewers through native delegation and their installed CLIs. Field Report does not run providers.

## Core policies

- Every commit and final candidate commissions comprehensive exact-target reviews from Codex, Cursor, and Claude.
- All three attempts must terminate. Two completed substantive GOs satisfy availability; provider failure is non-evidence, and any completed adverse evidence blocks.
- The owner uses native delegation for its own reviewer family and CLI launch for the other two. Reviewer models are not hardcoded.
- Review scores are explanatory; findings and deterministic gates remain authoritative.
- Field Report may mark a draft PR ready only after the publication gate passes. It never merges.

## State

Canonical mutable state lives outside the source checkout:

```text
~/.local/state/field-report/
  config.json
  projects/
  workstreams/
  reviews/
  delegations/
  events/
  projection.json
```

Override this location in tests or isolated environments with `FIELD_REPORT_STATE_ROOT`.

## Install

```bash
node scripts/install.mjs
fr init
```

The installer writes `~/.local/bin/fr` and links the same canonical skill sources into `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`. It refuses to replace a real directory at any of those paths.

Add repositories deliberately and install hooks explicitly:

```bash
fr project add aon --label AON --repo /path/to/aon --github owner/aon
fr hook install aon
fr hook status aon
```

Agents may self-register an unbound branch with `fr create`, or bind the correct existing outcome with `fr update --branch <current> --owner-task <current-task>`. This requires no coordinator approval; the commit gate prints exact commands when registration is missing.

The hook asks `fr gate commit` to verify exact staged-tree evidence for every commit in the managed repository.

## Factory flow

```bash
fr create aon-example --project aon --title "Example" --outcome "Deliver the bounded outcome" --branch codex/example
fr context aon-example
fr workflow workstream

fr review brief aon-example --kind commit --reviewer codex --route native
fr review brief aon-example --kind commit --reviewer cursor --route cli
fr review brief aon-example --kind commit --reviewer claude --route cli
# Launch the current host's family natively and the other two by CLI.
# Bind and record valid envelopes; record an unrecoverable provider attempt with `fr review fail`.
fr gate commit aon-example

fr review brief aon-example --kind final --reviewer codex --route native
fr review brief aon-example --kind final --reviewer cursor --route cli
fr review brief aon-example --kind final --reviewer claude --route cli
# Bind every final brief to its native task or provider-run ID before recording it.
fr review status aon-example --kind final
fr gate publish aon-example
fr publish aon-example
```

## Migration

Schema v1 corpus migration is intentionally one-way:

```bash
FIELD_REPORT_STATE_ROOT=/path/to/new-state node scripts/migrate-v1.mjs /path/to/legacy-field-report
```

Projects, workstreams, questions, links, milestones, and historical review records are preserved best-effort. Historical reviews remain visible but cannot satisfy schema-v2 gates.

## Dashboard

```bash
npm run dev
```

The dashboard is read-only except for refreshing external projections. All canonical changes and evidence recording go through the CLI.
