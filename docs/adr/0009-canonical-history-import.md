# ADR 0009: Import provider history into the canonical store

Status: Accepted

## Context

An existing Codex, Claude Code, or Hermes installation can already contain many
useful conversations before EXARCH is installed. Treating those
sessions as invisible would create an artificial split between old and new
work. Treating their mutable files or databases as the application's primary
store would surrender ownership and make cross-provider handoff unreliable.

## Decision

After bringing the loopback API and context socket online, the laptop daemon
starts non-blocking read-only history synchronization and provider monitoring:

- Codex is read through the pinned app-server `thread/list` and `thread/read`
  protocol, including archived threads.
- Claude Code transcripts are read from the configured local `projects`
  directory. The importer ignores nested subagent files and tolerates a partial
  final JSONL line.
- Hermes is read through `hermes sessions export --format jsonl --redact -`,
  which keeps its `state.db` authoritative and avoids direct database coupling.

Every native session is copied into a canonical conversation. A
`history_sources` record stores provider, native session ID, timestamps, digest,
status, and non-secret metadata. An `imported_items` ledger maps every native
item ID and content digest to the canonical event it produced. The unique
provider/session and source/item keys make repeated startup and manual refresh
safe and idempotent.

Provider payloads pass through the same pre-persistence redactor used for live
events. A changed native item never overwrites an owned event: the importer
appends a correction carrying `supersedesEventId`. Provider bindings are also
persisted so a new turn can resume the original Codex, Claude Code, or Hermes
session when supported; canonical context remains the fallback source of truth.

Databases created before this rule are migrated in place. Recognized credential
shapes are removed from legacy imported payloads, failure records, titles,
metadata, and FTS rows in one transaction. Payload rewrites necessarily change
the tamper-evident chain, so affected conversations are re-chained and the audit
log records both chain heads without retaining removed plaintext.

Import is local and read-only. It never deletes, archives, renames, or writes a
provider-native session. One provider's discovery failure does not roll back
successful imports from another provider. The authenticated API exposes import
status and an explicit refresh operation.

A working directory reported by a laptop-local native history reader is stored
as descriptive project metadata, not as authorization. If it does not match an
already enrolled project, the imported project has an empty execution scope and
is browse-only. The user must explicitly enroll that exact directory on the Mac
before either client can run a turn there. The mobile API has no operation that
accepts or broadens a filesystem path.

Databases created by an earlier prototype could contain history-inherited
scopes. Schema migration withdraws those grants unless an audit record proves a
laptop-local enrollment, while preserving conversation IDs and native provider
bindings.

## Consequences

- Existing canonical threads are available as soon as the API opens; imported
  native threads appear as their background synchronization completes.
- A historical thread remains browsable immediately and can resume after its
  directory is explicitly enrolled on the Mac.
- Imported data is owned in the encrypted canonical store and remains browsable
  even if a provider later removes its native session.
- Provider format drift can fail that provider's import without corrupting the
  canonical store.
- Imported history can only include state exposed by the provider. Hidden model
  state, ephemeral caches, and unrecorded reasoning cannot be reconstructed.
- Very large local histories do not block API startup, but their first complete
  synchronization can take time. Ongoing monitoring and authenticated refreshes
  reconcile later changes without changing the ledger model.
