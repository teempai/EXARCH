# Focus Flow Interface

Status: Current native macOS and iOS interface

Decision: [ADR 0008](../adr/0008-focus-flow-visual-direction.md)

## Character

Focus Flow is calm, precise, and operationally honest. It uses whitespace,
native typography, restrained semantic color, and progressive disclosure rather
than dashboard panels or decorative chrome. Light and dark appearances use the
shared tokens in `FocusFlowTheme`.

The hierarchy is:

1. the user's current thread or onboarding task;
2. live work and connection state;
3. approvals or errors needing attention; and
4. technical detail on demand.

## macOS desktop window

The desktop client uses `NavigationSplitView`.

The sidebar contains:

- the EXARCH wordmark;
- settings, appearance, and new-conversation controls;
- a concise connection/synchronization state;
- pinned threads ordered by recency;
- all remaining threads ordered by recency;
- provider and relative-update metadata for each row; and
- pair/unpair phone controls.

The detail pane uses the same conversation component as iOS. It displays a
fixed-height header with a truncated long title, provider and model controls,
policy details in settings, paginated messages, optimistic outgoing messages,
working state, approvals, capacity-failover choices, interrupt, and composition.

New conversations select only laptop-enrolled projects. Provider changes use a
confirmation dialog and remain disabled during active work.

When the encrypted store has no threads, the detail pane reports harness
discovery and native-history import as they run. This transient view disappears
when the scan finishes. Settings retains the harness results and a **Scan
again** action.

**Pair phone** opens a sheet containing the relay address and administrator
token fields, QR and copyable pairing code, 18-digit comparison, and a
progressively disclosed terminal-style activity log. Pairing completion
replaces the controls with a successful state.

## iOS thread browser

The first screen is a full-screen aggregate thread list rather than a sheet.
The first 30 saved rows appear immediately from the protected local cache while
a compact sync indicator reports background delta synchronization. Each loaded
30-thread batch has its latest 30 display messages prefetched; older threads and
messages load in further bounded batches.

Pinned threads form the first section and all other threads follow, both ordered
by recency. The top bar contains the EXARCH wordmark, more menu, and new-message
action without a redundant “Threads” title. The appearance control shares the
compact synchronization row below it.

## iOS conversation

The conversation header has a fixed height and truncates long titles. Harness
and model selection live in settings alongside the read-only effective laptop
policy and reported subscription capacity. Provider changes require explicit
confirmation. The same thread settings contain an ordered fallback route. A
route such as Codex → Claude Code → Hermes advances automatically only when the
current harness reports capacity exhaustion before accepting the message.

User messages use the quiet brass-tinted `accentSoft` surface. Assistant
messages sit on the canvas without a chat bubble. Native Markdown renders
headings, emphasis, lists, links, inline code, and copyable fenced code blocks.

Submitting places the user message in the timeline immediately. A “Working on
your laptop” row appears below it and is replaced by committed provider output.
The initial page contains 30 display messages; older pages load when the user
requests history at the top.

## Text and voice

Voice is entered from a microphone button inside the text composer rather than
a permanent mode row. Both paths submit the same text request. Text entry uses
the keyboard. Voice recognizes speech locally,
submits the finalized transcript, speaks the committed final answer, and then
resumes listening. Leaving voice mode, locking/backgrounding the app, or an
audio interruption stops capture and playback.

## Safety and status presentation

- Provider policy is visible but not editable.
- Approval sheets show the exact normalized action and native choices.
- Capacity exhaustion offers explicit healthy-harness alternatives.
- Offline and reconnect errors remain visible without erasing cached content.
- Unpairing states that phone authority is withdrawn before retryable relay-route
  cleanup, while laptop context remains.
- Color is never the only readiness, selection, failure, or approval cue.

## Visual tokens

`docs/design/STYLE_GUIDE.md` records the implemented wordmark, typography,
semantic colors, spacing, message surfaces, Markdown styling, interaction
targets, and accessibility behavior.
