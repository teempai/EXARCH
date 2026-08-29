# ADR 0007: Bundle an outbound end-to-end-encrypted relay connection

Status: Accepted

## Context

Internet-wide remote control must work without asking the user to install a VPN,
configure a router, expose a port, manage certificates, or operate a separate
networking client on the Mac. Direct inbound access cannot reliably cross consumer NAT and mobile
networks without one of those steps or external rendezvous infrastructure.

OpenAI Remote documents a secure relay between authorized devices, while Claude
Code Remote Control explicitly uses outbound HTTPS from the local process and
routes mobile/web messages through Anthropic's API. EXARCH uses the same
outbound user-experience pattern without making the relay the context owner.

## Decision

Ship the relay connector inside the Mac companion and the relay client
inside the native mobile app. Both initiate outbound TLS connections to the
compatible relay URL chosen during setup. The user installs no separate
networking software and opens no inbound port. EXARCH does not require a product
account and does not hardcode one project-operated relay.

Pairing establishes hardware-backed P-256 request/approval identities and binds
them to distinct Ed25519 libp2p transport peer IDs. Every connection performs
the standardized `Noise_XX_25519_ChaChaPoly_SHA256` handshake with ephemeral
X25519 keys and pinned remote peer identity. All application frames are then
end-to-end encrypted between the paired phone and laptop. Relay TLS is an
additional transport layer, not the content-security boundary.

The relay issues one-use, role-bound connection tickets from longer-lived
role-scoped access capabilities. The QR invitation carries only the first
one-use device ticket. The device access capability is delivered inside the
confirmed encrypted pairing completion, so a copied QR code is not a reusable
relay credential.

The relay routes opaque live frames, issues freshness challenges, and enforces
abuse limits. It holds no end-to-end decryption
key, provider credential, canonical event, artifact, repository content, or
backup. It does not durably queue commands in v1. An offline laptop is shown as
offline.

Canonical context, execution, provider sessions, policy, and search remain on
the laptop. The relay necessarily observes limited metadata
such as IP addresses, timing, routing identifiers, and frame sizes. It does not
store push tokens.

## Consequences

- Setup consists of a relay URL and operator credential in the Mac app, followed
  by mobile QR pairing.
- The laptop has no public listener and needs no VPN or router configuration.
- Availability and abuse prevention are responsibilities of the relay selected
  by the user, even though that relay is not a data or execution plane.
- Relay compromise cannot read or forge application content when endpoint keys
  remain secure, but it can deny service and observe traffic metadata.
- The repository ships the relay implementation so users can self-host it;
  compatible third-party relays can implement the same protocol.
