# Fable review operations

Load this reference only when Fable is selected as an independent reviewer.

## Launch boundary

- Verify the requested `claude-aws` Mantle/Bedrock route and exact model before launch; do not infer provenance from a familiar alias.
- Give Fable an explicit read-only brief tied to the exact candidate SHA. Allow Read, Grep, Glob, and only narrowly constrained read-only git commands. Deny editing, mutation, publication, and external messaging tools; plan mode alone is not a permission boundary.
- Ask for a completed envelope containing `review_complete: true`, provider/model provenance, reviewed SHA, verdict, findings, confidence, unresolved questions, and the required structural judgments.

## Evidence and liveness

- Persist raw `stream-json` for long reviews. Tool starts, results, and partial events are liveness even when final prose is delayed.
- Give evidence collection and synthesis separate bounded deadlines. Retry only the failed phase when persisted evidence is reusable.
- Treat permission, provider-route, or model-provenance failures as terminal orchestration signals. A vanished or partial final response never counts as a completed pass and must not erase collected findings.

## Reconciliation

- Fable is independent evidence, not universal primary authority. Reconcile its claims against the exact diff, contracts, tests, and other reviewer evidence.
- Record only a complete exact-head judgment in Field Report. Any substantive commit invalidates the pass until fresh or explicit delta review covers the new head.
