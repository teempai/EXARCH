# EXARCH Security Boundary

Status: Current locally ad-hoc-signed developer prototype, 2026-08-29

EXARCH remotely controls coding agents that can read files, execute commands,
and modify repositories with the authority configured on the Mac. No nontrivial
remote-control system is perfectly secure. This document states the controls
present in this repository, the assumptions they depend on, and the remaining
risks.

## 1. Protected assets

EXARCH handles:

- authority to send messages, interrupt turns, switch harnesses, and answer
  provider approvals;
- provider login state and credentials held by Codex, Claude Code, and Hermes;
- source repositories and uncommitted work;
- canonical conversation history and provider-session bindings;
- laptop, phone, request, approval, and relay credentials;
- provider policy observations and capacity data; and
- the phone's protected replica of received conversation pages.

## 2. Trust boundaries

```text
Untrusted repository and provider output
                  |
                  v
Provider child process -- turn-scoped context capability
                  |
           normalized events
                  v
Laptop daemon -- encrypted canonical store
       |                              |
signed loopback requests      pinned Noise encryption
       |                              |
native Mac client       untrusted selected relay       native iOS client
```

The relay, provider output, repository instructions, mobile request fields,
provider-native history, and process IDs from an earlier run are untrusted.
Loopback reachability alone is not authentication.

## 3. Assumptions

The implemented boundary assumes:

- the Mac kernel and user account are not fully compromised;
- the iPhone is passcode-protected and not fully compromised;
- the user can compare the pairing code on both devices;
- provider binaries come from channels the user trusts;
- the selected relay can observe traffic metadata and deny service but does not
  possess either endpoint's private keys; and
- the Mac firewall or outbound monitor permits both EXARCH endpoints to reach
  the selected relay.

An administrator/root compromise of the Mac can alter EXARCH, read data while
the user session is active, intercept provider credentials, or forge UI state.
A compromised unlocked phone can use the authority available to that paired
device even when its private keys remain non-exportable.

## 4. Current distribution boundary

The Mac app, native service, and Keychain helper use local development/ad-hoc
signing. They are not Developer ID/App Store signed or notarized. Private iOS
TestFlight builds have been used for testing, but Apple signing and distribution
are external to this repository and there is no public App Store release.

The native `EXARCH Service` is the LaunchAgent's responsible process, so macOS
protected-folder prompts identify EXARCH rather than a generic Node executable.
Node remains an internal child process.

The Keychain bridge is a narrow Swift command-line helper with fixed `get`,
`put`, and `delete` operations. Secret values travel over stdin/stdout and not
argv. It does not authenticate the identity of its caller. Another process
running as the same macOS user can invoke it and is therefore inside the current
prototype trust boundary. The local setup CLI can also perform local
administrative actions through this helper.

## 5. Local storage

The canonical database uses SQLite3MultipleCiphers/SQLCipher with a random
256-bit encryption key stored in macOS Keychain. Startup fails when encrypted
storage is required but unavailable. Configuration and runtime directories use
private modes and retain only non-secret Keychain account references.

Canonical events use per-conversation ordering and SHA-256 hash chains over
canonical JSON. Provider payloads and history imports pass through recursive
secret redaction before persistence. Redaction reduces accidental retention; it
does not prove that arbitrary secrets embedded in free-form natural language
are absent. Schema version eight also redacts recognized credential shapes from
legacy imported events, failure records, titles, metadata, and FTS rows. Because
payload changes invalidate later hashes, that migration re-chains each affected
conversation transactionally and records the old and new chain heads in the
audit log.

The phone cache contains only metadata and display-message pages already
received. It uses complete file protection, mode-`0600` files inside private
directories, atomic replacement, strict decode and size limits, and backup
exclusion. Forgetting the laptop removes the cache and phone-side credentials.

EXARCH currently has no canonical export, backup, restore, artifact store, or
conversation deletion interface. The uninstall script moves application data
to Trash and deliberately retains Keychain items.

## 6. Network boundary

The laptop HTTP/WebSocket API and context service bind only to loopback or a
mode-`0600` Unix socket. The phone cannot connect directly to either endpoint.
The Mac and phone initiate outbound TLS connections to the user-selected relay.

The relay service:

- routes one host and one device per random route;
- requires independent administrator, route, and role credentials;
- issues one-use role-bound connection tickets;
- disables WebSocket compression;
- enforces frame, byte, and connection-rate bounds;
- persists route revocations; and
- refuses trusted-proxy mode unless credential-bearing traffic is marked as
  HTTPS by the configured proxy.

The relay forwards only live opaque frames. It has no canonical data store,
durable message queue, or push-notification token store. It observes IP
addresses, connection timing, routing identifiers, and frame sizes. It can
delay, drop, reorder, or block traffic.

## 7. End-to-end transport

Phone and laptop application frames use pinned
`Noise_XX_25519_ChaChaPoly_SHA256` sessions with ephemeral X25519 keys, Ed25519
peer identities, ChaCha20-Poly1305, SHA-256, bounded frames, and a fixed EXARCH
application prologue. Relay TLS is an additional transport layer, not the
content-security boundary.

The phone and laptop pin each other's expected transport identity. Frame
authentication detects content modification, wrong peers, and cross-session
substitution. A fresh Noise session is established after reconnect.

The current transport implementation uses the pinned TypeScript libp2p Noise
package on the host and EXARCH's Swift implementation on iOS. The Swift side has
interop and tamper tests but has not undergone an independent cryptographic
review.

## 8. Pairing

The relay administrator credential creates route capacity only. It is sent to
the local setup command over stdin, never stored by EXARCH, and never delivered
to the phone. Possessing it does not authorize laptop API requests or decrypt a
session.

The pairing invitation is signed by the laptop application identity and binds:

- relay environment and opaque route;
- laptop application public key;
- expected laptop Noise peer identity;
- one-use device ticket;
- protocol version; and
- expiry.

Phone and laptop sign the pairing transcript and display the same derived
18-digit authentication string. Both endpoints require user confirmation. The
invitation is single-use, and the phone's reusable relay capability travels
inside the confirmed encrypted session.

One active `mobile-control` phone is supported. Full unpairing first writes a
durable pending-revocation state and revokes the phone's request and approval
keys. The daemon then retires the relay route, closes live sockets, deletes the
host route credential, and clears paired configuration. Relay cleanup retries
after failure and on daemon restart. Canonical context and the separate local
Mac client identity remain.

## 9. Request authentication

The iOS client has separate P-256 request and approval identities. The request
identity uses Secure Enclave where available. The approval identity is bound to
the current biometric set and requires local authentication for signing. The
transport identity is separate and stored in Keychain.

The Mac desktop client enrolls one `mac-client` principal after local user
authentication. It stores its keys in Keychain and signs requests just like the
phone. Complete key-pair idempotence, role validation, duplicate-Mac rejection,
key-drift rejection, and revoked-device rejection are enforced by the local
enrollment path.

Each application request binds:

- device ID and role;
- method and exact relative path;
- SHA-256 hash of the exact body;
- server-issued one-use challenge and expiry;
- persistent monotonic counter; and
- request timestamp.

Challenges have uniform response shapes for active, revoked, and unknown device
IDs. They are rate-bounded and single-use. Replayed, expired, modified,
wrong-key, wrong-role, and revoked-device requests fail authentication and are
recorded locally.

## 10. Approval and provider policy

Provider approval configuration remains authoritative in Codex, Claude Code,
or Hermes on the Mac. EXARCH observes and displays a normalized effective
policy. It does not edit that policy, remove a native prompt, or add a synthetic
prompt where the provider does not emit one.

Message submission binds the displayed policy revision. A changed or stale
revision rejects the request and forces a refresh.

Provider approval requests are normalized, redacted, bounded, stored with a
five-minute expiry, and delivered with the provider's exact available choices.
Approval decisions use the separate approval key and bind the exact normalized
action digest. Expired or already resolved approvals cannot be reused. Claude's
permission MCP bridge starts only for its provider session and fails closed on
disconnect, malformed input, or shutdown.

The Mac desktop approval flow can require Touch ID or the device password via
LocalAuthentication. Because the current same-user Keychain/setup boundary is
not caller-authenticated, it remains weaker than a signed, independently
authenticated local administration service.

## 11. Provider process containment

Provider adapters launch pinned protocol versions without a shell. Prompts are
sent over stdin rather than argv. Child stdout, stderr, frame sizes, and retained
diagnostics are bounded. Provider output is schema-validated and redacted before
canonical persistence.

EXARCH does not sandbox a provider beyond the provider's own configured laptop
policy. A permissive provider configuration remains permissive when invoked
through EXARCH. Repository content can still prompt-inject a provider into
actions allowed by that policy.

## 12. Project and workspace authority

New projects are enrolled only through the laptop-local setup command. Remote
clients can list and select enrolled projects but cannot submit arbitrary paths
or broaden a scope. A newly imported provider session records its laptop-reported
working directory as browse-only metadata; it gains execution scope only when
that directory was already enrolled or the user explicitly enrolls it on the Mac.

Path validation resolves symlinks and rejects filesystem roots, missing paths,
credential-bearing directories, and other forbidden locations. A transactional
one-writer workspace lease prevents simultaneous EXARCH turns from mutating the
same worktree. Stale leases are quarantined.

Git checkpoints use the system Git binary and record metadata and hashes. They
do not persist raw diffs or untracked file contents. Git hooks and provider tools
still execute with the authority available to their process.

## 13. Context capability

The context Unix socket is mode `0600`. Each provider turn receives a capability
file scoped to one project, conversation, turn, operation set, and a maximum
30-minute lifetime. Provider prompts receive read-only operations. Capability
cleanup occurs when a turn ends, and a process epoch invalidates capabilities
from an earlier daemon run.

The CLI exposes bounded canonical queries, not arbitrary SQL, file reads,
credential access, deletion, cross-project queries, or general shell execution.

## 14. Availability and failure behavior

- An offline or sleeping Mac is unavailable; the relay does not queue work.
- Relay compromise or outage can deny service and expose traffic metadata.
- A blocked first outbound connection can consume a one-use pairing attempt; a
  fresh invitation is then required.
- Provider discovery, authentication, protocol drift, or capacity errors are
  reported independently.
- Capacity failover replays a message only after explicit user confirmation and
  only when the failed harness performed no assistant, tool, or approval work.
- Provider switching is blocked while a turn or workspace lease is active.
- One provider-history import failure does not roll back other providers.

## 15. Current residual risks

- The Mac app and helper are not signed with a stable distribution identity or
  notarized.
- Same-user processes can invoke the Keychain helper and local setup command.
- The Noise implementation has automated interop and tamper coverage but no
  independent review.
- Provider CLIs and their own dependencies remain large trusted surfaces.
- Secret redaction cannot recognize every secret embedded in arbitrary text.
- A compromised endpoint defeats UI and process-level assurances available on
  that endpoint.
- No App Attest, independent penetration-test evidence, SBOM, or automated
  signed-update channel is present.
- No canonical backup/export or deletion workflow is present.
- Real-provider clean-device testing is manual.

These statements describe the current code and do not assert that EXARCH is
safe for public distribution or high-value production repositories.

## 16. Reporting a security issue

Use GitHub's private vulnerability-reporting flow from the repository's
**Security** tab. If **Report a vulnerability** is not available, do not open a
public issue containing vulnerability details; wait for the maintainers to
enable the private channel.

Do not include provider credentials, relay secrets, pairing invitations,
Keychain data, private repository content, or raw conversation history in a
public issue. Reproduce with synthetic data and report only the minimum logs
needed to identify the affected component. Rotate exposed relay or provider
credentials immediately through their owning service.
