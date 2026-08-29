# ADR 0001: Use a canonical append-only event store

Status: Accepted

## Context

Codex, Claude Code, and Hermes each maintain different native session formats,
context-compaction behavior, tool events, and lifecycle semantics. None is a
portable source of truth for a conversation that moves between providers.

## Decision

EXARCH stores a normalized, append-only canonical event stream in encrypted
local SQLite. Provider-native sessions are resumable caches identified by
bindings and synchronization cursors.

Raw canonical events are not replaced by summaries. Projections, current state,
decisions, tasks, and search indexes are derived and rebuildable. The repository
does not contain a large/binary artifact store.

## Consequences

- Provider switching can recover even if a native session disappears.
- The user owns the local primary record. EXARCH currently has no canonical
  export, backup, restore, or deletion controls.
- Adapters normalize provider events and preserve bounded unknown native
  payloads for diagnostics.
- The application cannot reproduce unexposed model-internal state.
- Schema evolution and event replay become core correctness concerns.
