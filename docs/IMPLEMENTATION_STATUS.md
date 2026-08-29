# Implementation Status

Status date: 2026-08-29

This document records verified implementation and current boundaries. The
checkout is installable as a locally ad-hoc-signed developer prototype; passing the suite
does not make it a signed or independently assessed distribution.

## Verified now

- Strict versioned schemas for canonical events, text-only message requests,
  effective provider policy, request authentication, and context protocol
- Canonical JSON encoding and SHA-256 event hash chains
- SQLite schema for all specified core tables, WAL mode, foreign keys, and FTS5
- Append-only per-conversation sequencing and tamper detection across histories
  longer than one query page
- Project-and-conversation-scoped full-text search with server-enforced limits
- Provenance-bound decisions and tasks
- Recursive pre-persistence secret redaction for known secret shapes and keys
- Transactional legacy-redaction migration that rebuilds affected event hash
  chains and FTS indexes while recording old and new chain heads
- Fail-closed startup when encrypted storage is required but SQLCipher is absent
- Pinned SQLite3MultipleCiphers/SQLCipher storage with a random 256-bit key; file
  tests prove plaintext absence, wrong-key rejection, and successful reopen
- Native macOS Keychain helper whose secret values travel over stdin, with only
  non-secret account references retained in mode-`0600` daemon configuration
- HMAC-authenticated, read-only provider context capabilities bounded to one
  project, conversation, turn, operation set, and a 30-minute maximum lifetime;
  cleanup revokes immediately and a process epoch invalidates pre-restart tokens
- Mode-`0600` Unix-socket context service and the actual `exarch-context` executable
  path
- Native-compatible P-256 paired-device request and approval signatures binding
  method, path, exact body hash, server challenge, monotonic counter, timestamp,
  and challenge expiration (with legacy Ed25519 conformance retained in tests)
- Uniform stateless one-time authentication challenges, bounded per-device and
  whole-route issuance, replay-counter enforcement, revocation, and local audit
  records
- Loopback-only HTTP API with read-only project discovery, authenticated conversation creation,
  provider status, message submission, harness switching, interrupt route, and
  ordered event retrieval, opaque cursor-based conversation metadata deltas,
  conversation-scoped context search, and a bounded, redacted tracked-changes
  view that never reads untracked file contents
- Authenticated WebSocket event replay and live subscription plumbing
- Laptop-policy revision binding before a message is accepted
- Coordinator idempotency for client message IDs
- Pre-persistence provider-output redaction
- Shell-free, stdin-only provider process supervision with bounded output,
  bounded stderr retention, and interrupt-to-kill escalation
- Version-pinned production adapters for Codex app-server `0.149.0-alpha.4.1` and `0.150.0-alpha.12.2`,
  Claude Code stream-json `2.1.87`, and Hermes structured TUI gateway `0.20.5`
- A checked-in generated Codex app-server protocol bundle and protocol-drift
  rejection tests for all three provider transports
- Provider-native session bindings that preserve exact user text for ordinary
  synchronized turns and inject canonical recent context only for an actual
  provider delta, such as a handoff or session reconstruction
- Startup and authenticated on-demand import of existing Codex, Claude Code,
  and Hermes threads into the encrypted canonical store, with provider/session
  provenance, item-level idempotency, append-only corrections, secret redaction,
  failure isolation, and persisted native-session resume bindings
- Laptop-local project enrollment, no mobile scope-mutation endpoint, browse-only
  projects for newly discovered native history, and explicit Mac enrollment
  before an imported directory gains execution scope
- Provider-native approval normalization for Codex, Claude, and Hermes, including
  bounded choices, pre-persistence redaction, five-minute pending records, and
  exact request digests
- A protected per-session Claude permission MCP bridge that is invoked only
  after Claude applies its existing settings, returns one-shot allow/deny
  decisions, and fails closed on disconnect, malformed input, or shutdown
- Separate P-256 approval-decision signatures, authenticated approval list and
  decision routes, provider delivery, audit events, and delivery-failure state
- Timed approval expiry with provider-native one-shot denial and an auditable
  interruption fallback when a provider exposes no denial choice
- Transactional single-writer workspace leases with bounded heartbeats,
  ownership checks, and stale-lease quarantine
- Shell-free Git checkpoints before and after every turn, including branch,
  HEAD, porcelain status hashes, dirty diff hashes, and bounded untracked-file
  metadata without persisting raw patch contents
- Explicit harness handoffs, with implicit provider changes rejected and any
  unresolved workspace lease blocking a switch
- Normalized capacity observations across all three adapters: live Codex and
  Claude Code windows when their pinned native protocols report them, truthful
  `not_reported` state for unsupported windows, and uniform structured
  exhaustion errors for Codex, Claude Code, and Hermes
- Laptop-owned, per-thread ordered fallback routes editable on macOS and iOS,
  with automatic healthy-next-harness handoff only for structured capacity
  exhaustion before provider acceptance, exact once-only replay, and a hard
  no-replay rule after any assistant, tool, or approval activity
- A pinned libp2p Noise XX transport using Ed25519 peer identities, ephemeral
  X25519 static keys, ChaCha20-Poly1305, SHA-256, remote-peer pinning, a fixed
  application prologue, bounded encrypted frames, and tamper/substitution tests
- An opaque live WebSocket relay with one host and one device per random route,
  no durable frame queue, compression disabled, byte/frame rate limits, one-use
  tickets, role-scoped access capabilities, authenticated provisioning, and a
  fail-closed trusted-TLS-proxy deployment contract
- A strict length-prefixed encrypted HTTP/RPC protocol and bundled host
  connector that forwards only validated relative `/api/v1` calls to loopback
- P-256-signed pairing invitations and confirmations, matching 18-digit SAS,
  Noise peer-ID binding, single-use invitation state, laptop confirmation, and
  encrypted delivery of the device's relay access capability
- A full automated phone-to-relay-to-Noise-to-loopback-laptop API test proving a
  P-256-authenticated request and three-provider response
- Deterministic provider adapter used only for integration and end-to-end tests
- Executable daemon entry point with strict private configuration, graceful
  shutdown, offline status, real provider adapters, context service, loopback
  API, and reconnecting host relay connector
- Idempotent laptop-local initialization of the encrypted context and core
  Keychain secrets before phone pairing, plus one-operation relay provisioning,
  administrator-token non-persistence, and one-use pairing
- Laptop-local device listing and immediate request/approval-key revocation
  through the setup CLI, enforced independently of relay connectivity
- Native local desktop client over a signed loopback-only transport, with one
  role-scoped Mac principal, user-authenticated first enrollment and unpairing,
  30-thread batches with 30-message prefetch per loaded thread, backward message
  pagination, optimistic sends, visible reconnect state, safe interruption, and
  capacity-exhaustion handoff
- User-selected relay setup with no product account, plus authenticated
  full-pairing removal from either client: durable local phone revocation before
  acknowledgement, retryable relay-route retirement and live-socket closure,
  host-credential deletion, explicit unpaired configuration, and preserved
  canonical context
- Turn-scoped `exarch-context` capability files and provider prompt discovery for
  bounded browsing of older canonical context
- Per-turn model forwarding for Codex, Claude Code, and Hermes, without changing
  the laptop's approval configuration
- Native single-window Focus Flow macOS client with transient first-run harness
  discovery and history-import status, explicit rescanning, and in-client phone
  pairing with a progressively disclosed redacted terminal view
- Native Focus Flow iOS client with Keychain/Secure Enclave identities,
  persistent anti-replay counters, enrolled-project conversation creation and switching,
  availability-aware harness/model selection, project-specific policy
  inspection, interrupt, biometric
  approval decisions, a LocalAuthentication app-entry privacy lock for an
  established pairing or cached laptop relationship,
  an immediate protected offline message-page replica, 30-thread batches with
  30-message prefetch per loaded thread, backward message pagination, background
  delta synchronization, an aggregate lazy thread browser, laptop-canonical
  pinning synchronized with macOS, message
  polling, and native GitHub-flavored
  Markdown presentation with selectable text, copyable code blocks, guarded
  links, and no remote-image fetches
- Unified on-device voice loop in which recognized speech becomes the same text
  request, exact committed final text is spoken, and listening resumes only when
  speech finishes
- Recoverable per-user macOS install/uninstall scripts with bounded rollback
  copies, non-zsh launchers, a narrowed service PATH, absolute system Git,
  native Keychain helper, a locally signed native `EXARCH Service` supervisor
  that owns macOS permission attribution while Node remains internal,
  LaunchAgent definition, Xcode iPhone installation entry point, and relay
  container definition
- An isolated full-installer verification that performs clean dependency and
  production staging, builds both native macOS artifacts, checks private modes
  and LaunchAgent paths, imports the installed runtime, and exercises the
  installed context CLI without touching the real user installation
- A process-level test that starts the real daemon from encrypted storage plus
  the secret-store bridge and serves a signed request through the opaque relay

The current suite contains 296 passing TypeScript unit, integration,
security-boundary, subprocess CLI, HTTP, and WebSocket tests plus 48 passing
Swift foundation and UI tests. The repository enforces minimum coverage thresholds of
85% lines/statements, 85% functions, and 80% branches for included runtime
modules.

## Current boundaries

- There is no artifact store, canonical backup/export/restore, or conversation
  deletion interface.
- Approval delivery has no crash-safe retry after its provider process exits.
- Provider process identity does not persist across daemon restart, and stale
  workspace leases require explicit Git inspection.
- One phone and one Mac desktop principal are supported; additional-device
  pairing is absent.
- The relay has no push wakeups, durable work queue, or deployment automation.
- The Mac application is not Developer ID signed or notarized. Private iOS
  TestFlight builds have been used, but this repository does not automate Apple
  distribution and there is no public App Store release.
- The automated suite does not exercise real providers on a clean physical Mac
  and iPhone.
- The repository contains no independent penetration-test report, SBOM, or
  reviewed native Noise assessment.

## Current proof commands

```text
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm test
PATH=/opt/homebrew/bin:$PATH npm run test:coverage
PATH=/opt/homebrew/bin:$PATH npm run build
PATH=/opt/homebrew/bin:$PATH npm run test:native-interop
PATH=/opt/homebrew/bin:$PATH npm run test:installer
cd native && PATH=/opt/homebrew/bin:$PATH swift test
cd native && PATH=/opt/homebrew/bin:$PATH swift build --triple arm64-apple-ios17.0 --sdk /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.5.sdk --target ExarchiOSCompile
cd native && xcodebuild -quiet -project EXARCH.xcodeproj -scheme EXARCHMac -configuration Release -destination platform=macOS -derivedDataPath .build/installer-xcode CODE_SIGNING_ALLOWED=NO build
```

Tests that bind temporary loopback ports or Unix sockets may need permission in
a restricted execution sandbox. Product services still reject non-loopback
bind configuration.
