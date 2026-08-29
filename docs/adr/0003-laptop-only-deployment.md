# ADR 0003: Use a laptop-only private deployment

Status: Accepted; transport revised by ADR 0007

Execution and canonical storage remain laptop-only. ADR 0007 records the
user-selected encrypted relay transport.

## Context

The intended user needs private remote control of coding agents already running
on one laptop. An always-on cloud control plane would add operations, custody,
and security complexity without being necessary for the initial use case.

## Decision

The API, coordinator, provider supervisors, canonical database, and context
service run on the laptop. The application binds to loopback and reaches the
phone through the user-selected encrypted relay with application-level device
pairing. EXARCH has no artifact store or backup subsystem.

The clients show the Mac as offline when no live host connection exists. New
work and uncached context are unavailable while the Mac is asleep or offline.

## Consequences

- All canonical data and provider credentials remain on user-controlled local
  storage.
- Installation is local rather than a multi-host deployment.
- Laptop availability and disk durability become product requirements.
- Network disconnects are recoverable, but laptop sleep is a hard availability
  boundary.
