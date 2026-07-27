# Workflow replay checkpoints

Phenix saves replay checkpoints for live workflows to reduce restart work. The event ledger remains the complete record of node visits, transitions, child runs, outcomes, and terminal state.

A checkpoint records:

- its format version;
- workflow definition ID and digest;
- the included event sequence;
- a snapshot digest;
- active and completed node activations;
- accumulated node results;
- transition traversal counts.

Child outcomes stay in child run records and are not copied into checkpoints.

## Recovery

Recovery uses the newest compatible checkpoint and replays later events. A checkpoint is ignored when its version, digest, event range, node references, result references, or transition counters are invalid.

An ignored or missing checkpoint does not fail the workflow. Recovery falls back to an older compatible checkpoint or replays the complete event stream.

Only live workflows receive new checkpoints. Multiple events from one transition are coalesced, and checkpoint write failures do not alter workflow state.

## Dynamic workflows

A dynamic workflow snapshot stores the generated definition. A replay checkpoint stores progress through that definition. Generated definitions are restored before their live workflow runs are recovered.

The workflow Markdown format has no checkpoint state. Checkpoint creation is automatic.
