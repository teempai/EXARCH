# ADR 0006: Use one text protocol for text and voice

Status: Accepted

## Context

Voice is a hands-free presentation loop, not a different conversation kind.
Separate audio events, voice sessions, or provider prompts create
context drift and make switching between text, voice, and providers harder to
reason about.

## Decision

The backend accepts and emits canonical text only. Typed text and a finalized
on-device speech transcript use the same message endpoint and produce the same
`user.message`. The server does not receive a modality flag, raw audio, partial
transcripts, or playback state.

In voice mode the native client submits the finalized transcript, waits for the
normal `assistant.message.completed` event, speaks that exact final text using
local speech synthesis, and opens the microphone again only after successful
playback completion. It never speaks deltas or tool output. Switching to text or
leaving the foreground stops both capture and playback.

On-device recognition is required by default. Voice input is unavailable when
the device or locale cannot satisfy that privacy requirement. Recognized speech
is message content only and cannot approve tools or operate the UI.

## Consequences

- Text and voice can alternate without backend branching or context migration.
- Canonical events contain only the text that was actually submitted and
  returned.
- Voice can be tested as a native-client state machine independent of provider
  adapters.
- Raw audio and partial recognition stay off the laptop and out of local
  canonical storage.
- The app handles audio-session interruption, lifecycle cancellation, and
  unsupported on-device recognition as explicit voice-session states.
