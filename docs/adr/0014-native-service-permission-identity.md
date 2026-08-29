# ADR 0014: Attribute laptop permissions to a native EXARCH service

Status: Accepted

## Context

The prototype LaunchAgent directly executed a Homebrew Node binary, which then
started Codex, Claude Code, and Hermes. macOS therefore identified `node` as the
responsible process when a protected project folder or the Codex Computer Use
helper required permission. The access was expected, but the generic process
name obscured which product initiated it and undermined informed consent.

Renaming a shell launcher cannot fix this attribution because `exec` replaces
the launcher with Node. Disabling provider capabilities would also violate the
decision that provider policy and configured tools remain laptop-authoritative.

## Decision

The local macOS installer embeds a native background-only app named
`EXARCH Service` inside `Exarch Desktop.app`. The per-user LaunchAgent starts its native
executable as the top-level responsible process. The service validates and
starts the internal runtime, remains alive for its lifetime, forwards orderly
shutdown signals, and returns the child's exit status. It never replaces itself
with Node.

The embedded service declares the stable development bundle identifier
`com.teempai.exarch.service` and human-readable protected-folder usage strings.
The local installer ad-hoc signs the complete nested application after
embedding the service. Node remains an implementation detail for now, and the
existing encrypted context, Keychain helper, pairing credentials, relay route,
and provider configuration are not migrated or replaced.

The current build uses ad-hoc signing rather than Developer ID/App Store signing
and installs a per-user LaunchAgent rather than ServiceManagement registration.

## Consequences

- Permission prompts initiated through the service identify EXARCH rather than
  a generic Node runtime.
- Prompts can reappear after local rebuilds because ad-hoc code identity is not
  stable across changed binaries.
- Provider-specific targets remain visible, for example when EXARCH requests
  access to the separately signed Codex Computer Use helper.
- The service must remain alive, supervise Node, forward termination signals,
  and fail closed when its configured child executable is invalid.
- The repository contains no notarized distribution or automatic-update path.
