# ADR 0008: Adopt Focus Flow as the visual direction

Status: Accepted

## Context

The desktop application must make installation and ongoing activity easy to
understand while retaining a truthful terminal-style view of background work.
The mobile application must feel as direct as a modern chat client while keeping
harness/model settings and voice capture readily reachable.

The interface is light, modern, and restrained. Avoiding clutter does not hide
approval policy, errors, security state, or work that affects the user's laptop.

## Decision

Adopt **Focus Flow** as the shared visual direction for the native macOS and
mobile clients.

The macOS client uses a focused current-step composition: one clear heading, the
minimum controls required for that step, and expandable terminal-style activity
below the structured pairing state. Agent discovery is represented as a short
list with provider readiness.

The mobile client opens on its aggregate thread browser and uses a
conversation-first composition after selection. Harness, model, capacity, and
policy live in the conversation settings sheet. A microphone control inside the
composer enters the local voice loop without changing the backend message
contract.

Use adaptive neutral surfaces, brass for identity and action, and separate
semantic colors for verified health, warnings, and failures. Prefer spacing,
typography, alignment, and progressive disclosure over additional containers,
decoration, or color.

The implemented interface is documented in
[Focus Flow](../design/focus-flow.md).

## Consequences

- The current task or conversation remains the dominant visual element.
- Terminal-style pairing detail is always reachable through disclosure.
- Harness and model selection remain in the conversation settings sheet.
- Voice remains reachable inside message composition without a persistent row.
- Approval requests may temporarily take visual priority but cannot become a
  permanent dashboard panel.
- New cards, persistent navigation items, badges, or colors require a concrete
  user task that cannot be served by the existing hierarchy.
- The native implementation owns the hierarchy and interaction rules directly.
