# ADR 0013: Adopt EXARCH as the product identity

Status: Accepted

## Context

The prototype began under a descriptive working title. The current product,
native apps, repository, commands, modules, installer, service, storage paths,
and documentation now need one concise identity.

Renaming an installed security-sensitive application is not equivalent to
starting a new application. Existing users may already have a paired device,
non-exportable keys, an encrypted canonical database, a protected mobile cache,
and a provisioned relay route.

## Decision

The product name is **EXARCH**. User-facing app names, the GitHub repository,
Xcode project and targets, Swift modules, CLI commands, daemon/service label,
Application Support directory, protocol namespaces, request headers, package
metadata, and documentation use that identity.

The macOS installer performs a one-time recoverable migration from the prior
Application Support, LaunchAgent, and app paths. During installation it copies
known legacy daemon secrets into the EXARCH Keychain service namespace without
deleting the legacy items. The shared Keychain layer also reads and copies a
legacy service item when the EXARCH item is absent. Explicit iOS removal deletes
the current and legacy aliases for phone-side items. The recoverable Mac
uninstall moves files to Trash and leaves Keychain items in place. The iOS cache
moves the prior cache folder inside the same protected app container.

One opaque deployment identifier remains a compatibility alias:

- The iOS bundle identifier stays stable so an installed development build can
  read its existing non-exportable Keychain keys and paired-laptop record.

It is not displayed as the product name. No relay hostname is compiled into the
clients; the user supplies a compatible relay during setup.

## Consequences

- Existing laptop context and pairing can survive the rename.
- New files, targets, binaries, services, and user-visible surfaces use EXARCH.
- Compatibility aliases are intentionally testable and documented instead of
  being mistaken for incomplete branding work.
- Protocol namespace changes require the phone and laptop clients to be
  updated together.
