# EXARCH Technical Specification

Status: Current developer prototype, 2026-08-29

This document describes only the implementation in this repository. Verified
test counts and commands are recorded in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## 1. Product boundary

EXARCH is a single-user native macOS and iOS interface for Codex, Claude Code,
and Hermes running on one Mac.

- The Mac owns execution, provider credentials, provider policy, repository
  access, and the encrypted canonical context store.
- The macOS desktop client and paired iPhone operate the same laptop daemon.
- A user-selected relay forwards opaque live encrypted frames between the phone
  and Mac. It does not execute providers or store canonical conversations.
- EXARCH has no vendor account, Sign in with Apple flow, allowlist, billing
  service, subscription, or bundled relay hostname.
- Text and voice produce the same canonical text message. Voice recognition and
  playback occur in the native client.

The Mac code is a locally ad-hoc-signed developer prototype and is not Developer ID signed
or notarized. Private iOS TestFlight builds have been used for testing, but this
repository does not automate Apple signing or distribution and there is no
public App Store release.

## 2. Components

### 2.1 macOS application

`native/Apps/macOS` builds the single-window `EXARCHMac` application. The
desktop client:

- shows first-run harness discovery and native-history import in the empty
  conversation pane;
- exposes harness results and explicit rescanning in Settings;
- pairs a phone from the sidebar using a user-supplied
  `wss://.../v1/relay` address, relay administrator token, one-use QR/paste
  code, 18-digit comparison, and copyable terminal-style activity;
- enrolls one `mac-client` principal after local user authentication;
- authenticates every loopback API request with signed request envelopes;
- shows the first 30 pinned-and-recent threads in a native split view and loads
  further 30-thread pages on demand;
- prefetches the latest 30 display messages for every loaded thread and
  retrieves older 30-message pages on demand;
- keeps an outgoing message visible while provider work runs;
- creates conversations only in laptop-enrolled projects;
- shows provider, model, capacity, effective laptop policy, and connection
  state;
- switches harness only after user confirmation and only while no turn is busy;
- delivers provider approvals, with local authentication where required;
- interrupts the active conversation turn;
- offers an explicit healthy-harness retry after a structured capacity error;
- pairs or unpairs the phone; and
- supports light and dark appearance.

The desktop client works locally without a phone pairing. Its identity is
separate from the `mobile-control` phone identity and remains enrolled when the
phone is unpaired.

### 2.2 macOS service and TypeScript daemon

The per-user LaunchAgent starts the native `EXARCH Service` executable embedded
inside `Exarch Desktop.app`. The native supervisor owns macOS permission
attribution, validates and starts the staged Node runtime, stays alive while it runs, and
forwards termination.

The TypeScript daemon:

- opens the encrypted canonical database;
- starts the authenticated loopback HTTP/WebSocket API;
- starts the mode-`0600` context Unix socket;
- monitors and synchronizes provider-native history in the background;
- supervises Codex, Claude Code, and Hermes child processes;
- enforces device, request, project, policy-revision, and workspace-lease
  checks; and
- maintains the outbound relay connection when a phone is paired.

No EXARCH service listens on a non-loopback laptop interface.

### 2.3 Native iOS client

The SwiftUI iOS application:

- pairs by scanning or pasting the Mac invitation;
- verifies the laptop identity and matching 18-digit code;
- stores request, approval, and transport identities in Keychain/Secure
  Enclave-backed storage where the platform supports it;
- requires device-owner authentication when opening an established pairing or
  cached laptop relationship; a new unpaired install can reach pairing directly;
- displays one aggregate thread list with laptop-canonical pins first, shared
  with the macOS client;
- immediately displays the first 30 threads from its protected local replica,
  then synchronizes deltas and loads further 30-thread pages on demand;
- prefetches 30 recent messages for every loaded thread and paginates backward
  in 30-message pages;
- renders native GitHub-flavored Markdown without remote image fetching;
- sends text, switches provider/model, interrupts work, and handles approvals;
- offers another healthy harness after a structured capacity error;
- recognizes speech on-device, submits the finalized text through the normal
  message endpoint, speaks the committed final answer, and resumes listening;
  and
- removes its keys and cached laptop data when the laptop is forgotten.

The iOS Simulator supports pasted pairing invitations and development software
keys. It does not support QR camera scanning or Secure Enclave behavior.

### 2.4 Relay

`services/relay` is a self-hostable HTTPS/WebSocket service. It provides:

- authenticated route creation and retirement;
- one host and one device role per random route;
- role-scoped access capabilities and one-use connection tickets;
- opaque live WebSocket forwarding with compression disabled;
- frame, byte, and rate bounds;
- durable route revocation state; and
- a fail-closed trusted-TLS-proxy deployment mode.

The relay has no durable command queue and no push-notification subsystem. An
offline Mac cannot receive new work.

### 2.5 Local command-line tools

The Node package exposes four commands:

- `exarch-daemon` — laptop runtime;
- `exarch-relay` — relay service;
- `exarch-setup` — local project, pairing, device, and status administration;
- `exarch-context` — bounded canonical-context access for active provider turns.

The Mac installer stages `exarch-daemon`, `exarch-setup`, and `exarch-context`
inside its private runtime. The relay is built and deployed separately.

## 3. Local data ownership

The installed layout is:

```text
~/Applications/Exarch Desktop.app
~/Library/LaunchAgents/com.teempai.exarch.daemon.plist
~/Library/Application Support/EXARCH/
  config.json
  data/
    context.sqlite
    context.sock
    turn-capabilities/
    runtime-status.json
  logs/
  runtime/
```

`context.sqlite` uses SQLite3MultipleCiphers/SQLCipher with a random 256-bit key
stored in macOS Keychain. Configuration retains non-secret Keychain account
references, not secret values. The database stores canonical events,
projections, decisions, tasks, provider bindings, provider-history import
ledgers, enrolled projects, devices, approvals, workspace leases, and audit
records.

EXARCH currently has no artifact store, export, backup, restore, or canonical
conversation deletion interface. The uninstall script moves application files,
runtime, configuration, and database to Trash and retains Keychain items, so
the local installation remains recoverable until Trash is emptied.

## 4. Canonical conversation model

Every conversation has one append-only ordered event stream. Each event carries
a conversation sequence, type, provider, timestamp, payload, previous hash, and
event hash. Event hashes use canonical JSON and SHA-256. Projections are derived
from the stream.

Persisted provider output passes through recursive secret redaction. Unknown or
unsupported provider data is bounded before persistence. Provider-native
sessions are resumable bindings, while the canonical store remains the EXARCH
record used for cross-harness context.

Ordinary turns in an existing synchronized native session send the user's exact
message to that provider. EXARCH injects a bounded canonical context envelope
only when the target provider has a real context delta, such as a harness
handoff or native-session reconstruction. Older context remains available
through the turn-scoped context CLI.

## 5. Provider history synchronization

The daemon starts the local API first, then synchronizes provider history in the
background and monitors it for changes.

- Codex history uses the pinned app-server `thread/list` and `thread/read`
  protocol, including archived threads.
- Claude Code history reads local project JSONL transcripts, ignores nested
  subagent files, and tolerates a partial final line.
- Hermes history uses `hermes sessions export --format jsonl --redact -`.

Each source session and native item has an idempotency ledger. Repeated refresh
does not duplicate events. Changed native items append corrections rather than
overwriting stored events. One provider's import error does not roll back the
others.

A native working directory is retained as descriptive project metadata, but a
history transcript is not an authorization act. A newly discovered imported
project is browse-only until the user explicitly enrolls that exact directory
on the Mac. If the directory was already enrolled, the imported thread reuses
that existing scope. The remote API cannot submit or broaden a filesystem path.

## 6. Provider adapters and turns

The repository pins these native protocol surfaces:

- Codex app-server `0.149.0-alpha.4.1`;
- Claude Code stream-json `2.1.87` plus the protected permission MCP bridge;
- Hermes structured TUI gateway `0.20.5`.

All provider processes launch without a shell. User prompt data travels over
stdin, not argv. Stdout and stderr are bounded, parsed, normalized, and
redacted. Interrupt escalates from the provider's normal cancellation mechanism
to process termination.

Before each turn, the daemon:

1. authenticates and validates the signed request;
2. confirms the conversation, project, and selected provider;
3. checks the displayed effective-policy revision;
4. acquires the single-writer workspace lease;
5. records a Git checkpoint without persisting raw patch contents;
6. starts or resumes the provider session; and
7. records normalized provider events and a final checkpoint.

The effective approval policy remains provider-owned on the laptop. EXARCH
observes and displays it but does not edit it or add synthetic prompts.

Codex, Claude Code, and Hermes capacity failures normalize to the same structured
error. Codex and Claude capacity windows appear when their native protocols
report them. Unsupported capacity data is labeled `not_reported`; EXARCH does
not estimate percentages.

## 7. Harness switching

Provider changes are explicit handoffs. The client asks for confirmation before
moving a conversation to another harness. A busy turn or unresolved workspace
lease blocks the switch.

The daemon checkpoints repository state, records handoff events, computes the
canonical delta missing from the destination binding, starts or resumes the
destination native session, injects only that bounded delta, and advances the
binding cursor after acceptance. Switching back uses the same process.

After a capacity failure that occurs before provider work begins, the clients
offer healthy alternative harnesses. User confirmation performs one handoff and
replays the original message once. If any assistant, tool, or approval activity
already exists, EXARCH does not replay the message.

## 8. Projects and workspace safety

Projects for new conversations are enrolled locally:

```sh
exarch-setup project-add --name "My project" --repo-root /absolute/path
```

The mobile and desktop conversation forms can select only enrolled projects.
Path validation resolves symlinks and rejects broad or credential-bearing
locations. The daemon maintains a transactional one-writer lease per worktree,
uses bounded heartbeats, and quarantines stale leases until reconciliation.

Git checkpoints record repository root, branch, HEAD, porcelain status hashes,
dirty diff hashes, and bounded untracked-file metadata before and after a turn.
Raw file contents and patches are not stored in the canonical database.

## 9. Context CLI

Provider turns receive a capability file scoped to one project, conversation,
turn, operation set, and expiration. The provider prompt receives read-only
operations. The capability file is mode `0600`, is removed when the turn ends,
and becomes invalid after daemon restart.

Implemented read commands:

```text
exarch-context current [--format json|text]
exarch-context recent [--limit N] [--before SEQUENCE]
exarch-context search QUERY [--limit N]
exarch-context event show EVENT_ID
exarch-context events range FROM TO
exarch-context decisions [--status active|superseded|all]
exarch-context tasks [--status open|completed|all]
exarch-context repo-state
exarch-context handoffs [--limit N]
exarch-context help --json
```

Authorized local callers can also append or supersede decisions and append or
complete tasks. The CLI exposes no arbitrary SQL, file read, deletion,
credential access, cross-project query, or general shell execution.

## 10. Laptop API

The daemon binds its HTTP/WebSocket server to `127.0.0.1`. Except for uniform
health and challenge behavior, application routes require a signed request
envelope with method, path, exact body hash, one-use challenge, persistent
counter, timestamp, and expiry.

Implemented route groups:

- provider status, capacity, and effective policy;
- history-import status and authenticated refresh;
- read-only project listing;
- conversation creation, detail, aggregate synchronization, and event pages;
- message submission, explicit provider handoff, and interrupt;
- approval listing and signed decisions;
- bounded context search and tracked Git changes;
- full pairing revocation; and
- authenticated WebSocket replay/live event delivery.

The encrypted relay protocol carries length-prefixed relative `/api/v1`
requests. The host connector validates the request and forwards it only to the
loopback daemon.

## 11. Pairing and revocation

Setup requires the user-selected relay address and its administrator token. The
token reaches `exarch-setup` over stdin, provisions one route, and is not stored
by EXARCH or sent to the phone.

The one-use invitation binds the relay environment, route, stable laptop
application public key, expected Noise peer identity, protocol version, and
expiry. The phone and laptop establish a pinned Noise XX session and sign the
pairing transcript. Pairing completes only after the user confirms the same
18-digit code on both devices. The phone's long-lived relay capability is
delivered inside the confirmed encrypted session.

Full unpairing:

- durably marks relay revocation pending and revokes the phone's request and
  approval identities in the laptop database before acknowledging the phone;
- retires the complete relay route and closes its sockets after that response,
  retrying on failure and daemon restart;
- deletes the host relay credential and clears paired relay configuration after
  relay retirement; and
- preserves canonical context and the local Mac desktop identity.

Device-only revocation is also available through `exarch-setup revoke`.

## 12. Mobile replica and presentation

The phone stores only conversation metadata and message pages it has already
received. The cache uses complete file protection, private directory/file
modes, atomic writes, strict decode/size bounds, and backup exclusion. App launch
shows this replica immediately and synchronizes bounded metadata and event
deltas in the background.

Pins are canonical conversation metadata owned by the laptop and synchronized
between the Mac and phone. Message pages contain user messages, completed
assistant messages, and harness handoffs; internal tool events remain
laptop-side unless a dedicated bounded route requests them.

Markdown rendering supports headings, emphasis, lists, links, inline code, and
copyable fenced code blocks. Links require an explicit user action and remote
images are not fetched.

## 13. Voice behavior

The backend accepts text only and has no voice-mode field. In voice mode the
native client:

1. captures an on-device speech transcript;
2. submits the finalized transcript as the normal text message body;
3. waits for the committed `assistant.message.completed` event;
4. speaks that exact final text locally; and
5. begins the next microphone capture after playback finishes.

Raw audio, partial transcripts, playback buffers, and voice-mode state do not
reach the laptop, relay application protocol, canonical database, logs, or
exports. Voice input does not approve tools.

## 14. Current security boundary

The implemented controls include encrypted local storage, Keychain-held
secrets, outbound-only relay connectivity, pinned end-to-end Noise encryption,
separate request and approval signatures, one-use challenges, persistent
counters, project scope validation, policy-revision binding, device revocation,
workspace leases, bounded parsers, secret redaction, and loopback-only APIs.

The current Keychain bridge is a locally ad-hoc-signed command-line helper, not
a caller-authenticated IPC service. Another process running as the same macOS
user is inside the prototype trust boundary. The Mac application is not
Developer ID signed or notarized. Detailed assumptions and residual
risks are in [`SECURITY.md`](SECURITY.md).

## 15. Repository structure

```text
apps/
  context-cli/     exarch-context command
  setup-cli/       local administration command
native/
  Apps/iOS/        iOS application
  Apps/macOS/      setup and desktop application
  Sources/         shared Swift foundation, UI, service, and Keychain helper
  Tests/           Swift tests
packages/
  core/            canonical store, context, coordinator, and security
  protocol/        shared schemas
  relay/           encrypted relay protocol and RPC transport
services/
  daemon/          laptop API, adapters, history, and host connector
  relay/           opaque relay service
scripts/           install, open, and verification scripts
tests/             integration and security-boundary tests
docs/              current setup, status, design, and architecture records
```

## 16. Current limitations

- The Mac application and helper use development/ad-hoc signing and are not
  notarized.
- The Keychain command helper accepts calls from other processes running as the
  same macOS user.
- The phone supports one paired laptop and the relay route supports one host and
  one device.
- The relay has no durable work queue or push wakeups.
- Canonical artifacts, exports, backups, restore, and conversation deletion are
  absent.
- Real-provider end-to-end tests on a clean physical Mac/iPhone are not part of
  the automated suite.
- Android is absent.
