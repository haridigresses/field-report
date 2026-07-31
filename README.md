# Field Report

Field Report is a local software-factory policy and evidence harness. It keeps durable outcome state, gives coordinators and workstream owners canonical operating instructions, issues exact-target review briefs, validates completed evidence, and evaluates commit and publication gates.

Field Report does not execute Codex, Claude, or provider processes. Coordinators launch native Codex agents; configured provider tools execute reviews; Field Report verifies that the required work was completed against the correct target.

## Core policies

- Every commit in a managed repository requires distinct Sol deep-code and structural reviews of the exact base HEAD and staged tree.
- Every final candidate requires distinct exact-head Sol deep-code and structural reviews.
- Full final review also requires Fable through `claude-aws`.
- Mini review may waive only Fable after deterministic eligibility and agreement from both final Sol reviewers.
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

fr review brief aon-example --kind commit --role deep-code-review
fr review brief aon-example --kind commit --role structural-challenge
# Launch two distinct native Sol subagents and save their JSON envelopes.
fr review bind aon-example --delegation <deep-uuid> --task-id <deep-native-task-id>
fr review bind aon-example --delegation <structural-uuid> --task-id <structural-native-task-id>
fr review record aon-example --file /tmp/deep.json
fr review record aon-example --file /tmp/structural.json
fr gate commit aon-example

fr review brief aon-example --kind final --role deep-code-review
fr review brief aon-example --kind final --role structural-challenge
fr review brief aon-example --kind final --role fable-challenge
# Invoke configured claude-aws externally for the Fable brief.
# Bind every final brief to its native task or provider-run ID before recording it.
fr review status aon-example --kind final
fr gate publish aon-example
fr publish aon-example
```

## Mini review

```bash
fr classify aon-example mini --reason "Bounded presentation-only correction"
```

Eligibility combines configured size limits, risky-path exclusions, a recorded reason, and affirmative judgment from both final Sol reviewers. Commit review is unchanged.

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
