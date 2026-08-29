# ADR 0010: Use an offline-first mobile thread cache

Status: Accepted

## Context

Opening the mobile app must not require a full replay of every thread through
the relay. Provider-history import can produce a large unified thread library,
and the relay is a transport rather than a durable application store. A blank
screen while the laptop is contacted would make the native client feel slow and
would make saved history unavailable whenever the laptop is asleep.

The laptop must nevertheless remain the user-owned canonical source of truth.
Mobile retention must not turn the relay into storage, create a second writer,
or weaken device-at-rest protections.

## Decision

The native mobile client maintains a read-only local replica of the display
message pages it has received:

- a compact index containing projects, provider observations, conversation
  metadata including the laptop-canonical pin state, the opaque conversation
  cursor, and the last active thread;
- one protected event file per conversation, with the latest 30 display
  messages prefetched for each loaded 30-thread batch; and
- no audio, partial speech transcript, provider credential, relay
  administrator credential, approval secret, or unredacted configuration.

At launch the app reads the local index before making a network request. It
presents the first 30 saved threads immediately, marks the view as syncing, and
then requests deltas from the laptop. A failed sync leaves saved
threads readable and labels them as offline; it does not replace the app with a
blank connection-error screen.

Conversation metadata uses
`GET /api/v1/conversations/sync?cursor=<opaque>&limit=<n>`. The opaque versioned
cursor represents the laptop store's monotonic conversation-change sequence.
Pages are applied and checkpointed one at a time, so an interrupted sync resumes
from the last stored page. Each loaded 30-thread batch prefetches the 30 most
recent user, assistant-final, and harness-handoff messages for every thread.
Opening a thread refreshes that window. The client requests older pages in
30-message batches on demand at the top, and polls for new display
messages strictly after its highest saved sequence. Internal tool events,
streaming deltas, and diffs stay canonical on the laptop unless a
dedicated bounded view requests them. The relay therefore never has to replay a
thread's complete internal event stream merely to render its transcript.

The iOS cache lives in Application Support, uses complete file protection while
the device is locked, mode-`0600` files inside mode-`0700` directories, atomic
writes, strict decode and size limits, and exclusion from cloud/device backups.
Forgetting a laptop deletes its complete cache directory. The repository has no
Android client.

The thread browser is one aggregate, newest-first list across Codex, Claude
Code, and Hermes. Pins are canonical conversation metadata owned by the laptop,
synchronized through the conversation change cursor, and displayed in a
section at the top by both native clients. The phone caches the last received
pin state for immediate offline display. The remaining rows are lazy and reveal
additional pages in fixed-size batches.

## Consequences

- Relaunch is immediate and useful even while the laptop is unreachable.
- The relay is not asked to retransmit the complete known history on every
  launch.
- Opening a previously unseen long thread transfers a recent useful window
  rather than its complete canonical event chain.
- The laptop store remains canonical; the mobile replica never accepts writes
  except as authenticated laptop responses and local presentation preferences.
- A compromised unlocked phone can expose whatever redacted history that phone
  has received. Device passcode, OS file protection, backup exclusion, remote
  device revocation, and an explicit Forget Laptop action reduce but cannot
  eliminate this risk.
- The current canonical model does not expose conversation deletion or a
  deletion tombstone in the delta protocol.
