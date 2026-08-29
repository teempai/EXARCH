# ADR 0012: Let the user choose and administer the relay

Status: Accepted; replaces the earlier Apple-identity proposal

## Context

EXARCH is distributed as self-hostable open-source software. Requiring an
EXARCH account, a vendor allowlist, Sign in with Apple, or a subscription would
make the open-source client depend on a product-operated identity service and
would prevent an operator from using an independent compatible relay.

The relay still needs an administrative boundary for creating and retiring
opaque routes. That is an operator concern, not a user-account system. The Mac
app already accepts a relay URL and administrator credential over a local
process pipe, never persists the administrator credential, and uses it only to
provision one route.

## Decision

EXARCH has no vendor signup or hosted-account flow. During setup, the user:

1. Chooses a compatible relay operated by themselves or by a party they trust.
2. Enters its `wss://.../v1/relay` address in the Mac app.
3. Enters that relay's administrator token in the Mac app.
4. Lets the Mac provision one random opaque route.
5. Pairs the phone through the QR code, Noise handshake, transcript signatures,
   separate request and approval keys, and matching 18-digit code.

The administrator token is sent to `exarch-setup` over stdin, is used only for
the route-management request, is never sent to the phone, and is never written
to EXARCH configuration, logs, argv, or the canonical database. The operator
may rotate it after provisioning. A later re-pair requires either the current
administrator token or a newly rotated one.

The relay URL is configuration, not an application constant. Official builds
must not silently substitute a project-operated relay or prevent a user from
entering another compatible relay.

The relay administrator decides who receives its administrator token. EXARCH
does not add an identity provider, email allowlist, billing database, or
subscription check in front of it. The laptop initializes and operates locally
without a relay; the relay is requested only from **Pair phone**. Device
authorization remains independent:
possession of the relay administrator token can create relay capacity but does
not pair a phone, decrypt traffic, sign a laptop request, approve an action,
broaden project scope, or change provider policy.

## Relay and device lifecycle

- Relay route identifiers and role capabilities are random and scoped.
- Removing a pairing durably records pending revocation and revokes the paired
  device in the laptop database before acknowledging the phone. Relay-route
  retirement, live-socket closure, host-credential deletion, and configuration
  cleanup then complete with retry on failure or daemon restart.
- Route revocations are durable across relay restarts.
- A newly paired phone receives its device relay capability only inside the
  confirmed end-to-end encrypted channel.
- The laptop daemon remains loopback-only; both endpoints make outbound
  connections to the chosen relay.

## Distribution modes

The same applications support both modes without changing the trust model:

- **Self-hosted:** the user deploys the included relay and controls both relay
  secrets.
- **Third-party relay:** an operator supplies a compatible URL and temporary
  administrator credential under its own availability and privacy terms.

Neither mode grants the relay access to canonical conversations, repositories,
provider credentials, request keys, approval keys, or Noise session keys.

## Consequences

- There is no signup screen, account recovery, account deletion, Apple identity
  dependency, or subscription entitlement in the OSS product.
- Setup has one additional operator-supplied URL and credential compared with a
  bundled hosted service.
- Relay availability, abuse controls, costs, retention, and administrator-token
  custody belong to the selected relay operator.
- A third-party relay remains optional and protocol-compatible; it is not the
  authority for laptop access or local data.
