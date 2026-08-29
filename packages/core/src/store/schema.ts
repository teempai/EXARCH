export const SCHEMA_VERSION = 9;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA trusted_schema = OFF;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL UNIQUE,
  allowed_paths_json TEXT NOT NULL,
  root_device TEXT,
  root_inode TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleting', 'restoring')),
  active_provider TEXT CHECK (active_provider IN ('codex', 'claude', 'hermes')),
  fallback_route_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Conversation display timestamps can come from imported provider history and
-- therefore move backwards. Keep a separate monotonic change cursor for
-- incremental mobile synchronization.
CREATE TABLE IF NOT EXISTS conversation_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS conversation_changes_after_insert
AFTER INSERT ON conversations
BEGIN
  INSERT OR IGNORE INTO conversation_changes(conversation_id) VALUES (NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS conversation_changes_after_update
AFTER UPDATE ON conversations
BEGIN
  DELETE FROM conversation_changes WHERE conversation_id = NEW.id;
  INSERT INTO conversation_changes(conversation_id) VALUES (NEW.id);
END;

-- Backfill existing databases when version three is first opened. Ordering is
-- deterministic, but subsequent cursors depend only on the monotonic sequence.
INSERT OR IGNORE INTO conversation_changes(conversation_id)
SELECT id FROM conversations ORDER BY updated_at, id;

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'hermes')),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  provider TEXT,
  payload_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, event_hash)
);

CREATE INDEX IF NOT EXISTS events_conversation_sequence
  ON events(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS events_type_provider
  ON events(type, provider);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  event_id UNINDEXED,
  conversation_id UNINDEXED,
  project_id UNINDEXED,
  type UNINDEXED,
  provider UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS provider_bindings (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  provider TEXT NOT NULL,
  native_session_id TEXT,
  synchronized_through_sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, provider)
);

CREATE TABLE IF NOT EXISTS history_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'hermes')),
  native_session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
  source_created_at TEXT,
  source_updated_at TEXT,
  source_digest TEXT NOT NULL,
  import_status TEXT NOT NULL CHECK (import_status IN ('importing', 'complete', 'partial', 'failed')),
  imported_item_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_item_count >= 0),
  last_error TEXT,
  last_synced_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (provider, native_session_id)
);

CREATE INDEX IF NOT EXISTS history_sources_provider_updated
  ON history_sources(provider, source_updated_at DESC);

CREATE TABLE IF NOT EXISTS imported_items (
  history_source_id TEXT NOT NULL REFERENCES history_sources(id) ON DELETE CASCADE,
  native_item_id TEXT NOT NULL,
  canonical_event_id TEXT NOT NULL REFERENCES events(id),
  content_digest TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (history_source_id, native_item_id)
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  source_from_sequence INTEGER NOT NULL,
  source_to_sequence INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  generator_provider TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  source_event_ids_json TEXT NOT NULL,
  superseded_by_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  source_event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  origin_event_id TEXT,
  logical_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_identifier TEXT NOT NULL,
  encryption_metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  decision_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS workspace_leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_path TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read-only', 'mutating')),
  scope_kind TEXT NOT NULL DEFAULT 'path' CHECK (scope_kind IN ('git', 'path')),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_processes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT,
  provider TEXT NOT NULL,
  pid INTEGER,
  process_identity_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  approval_public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  last_counter INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL,
  attestation_json TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS security_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject_id TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;
