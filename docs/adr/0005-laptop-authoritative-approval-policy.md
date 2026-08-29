# ADR 0005: Keep approval policy authoritative on the laptop

Status: Accepted

## Context

Codex, Claude Code, and Hermes each have provider-native permission and approval
behavior. Adding another configurable execution policy to EXARCH
would create conflicting sources of truth and make the mobile display difficult
to trust. The user wants remote control to behave exactly like the provider as
configured on the laptop.

Control-plane authentication and workspace containment are still required to
protect the remote boundary, but they are not substitutes for provider approval
configuration.

## Decision

The effective provider configuration on the laptop is the sole execution
approval policy. Adapters do not change it at launch. They observe it through a
supported native interface, normalize a redacted read-only view for mobile, and
relay provider-emitted approval requests and native choices.

The mobile interface cannot change approval mode, reviewer, sandbox, permission
profile, managed requirements, or persistent allow rules. Each turn binds the
displayed policy revision. A revision race rejects submission and refreshes the
display. Unknown or partially observable policy fields are labeled as such and
are never guessed.

The daemon separately enforces device authentication, project enrollment,
request freshness, and workspace mutation leases. These controls may deny a
request, but cannot broaden provider authority or remove a provider prompt.

## Consequences

- Remote behavior matches normal laptop behavior and has one configuration
  source.
- The UI can explain effective authority without becoming a settings editor.
- A permissive laptop policy remains permissive remotely; users must harden it
  on the laptop when they want more prompts.
- Adapter policy introspection and parity tests cover the implemented provider
  boundary.
- Persistent rules remain a laptop-native concern.
