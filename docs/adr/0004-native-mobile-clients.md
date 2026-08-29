# ADR 0004: Build separately native mobile clients

Status: Accepted

## Context

The mobile client controls local coding agents that can read and modify source
code, run commands, and request access to other laptop resources. Device keys,
approval authorization, protocol validation, and sensitive rendering therefore
sit on a high-impact security boundary.

A PWA cannot provide the implemented level of platform key isolation, biometric
gating, controlled local storage, and lifecycle snapshot concealment. A
cross-platform runtime would also place an additional bridge and
dependency ecosystem inside the trusted computing base.

## Decision

Build the first client as a native SwiftUI iOS application. Use Swift,
URLSession, CryptoKit, Security, LocalAuthentication, Keychain, and Secure
Enclave-backed keys where supported.

The repository contains no Android client and no JavaScript mobile runtime.

The native client is not the canonical store. It keeps a protected,
backup-excluded local replica of only the conversation pages and metadata it has
already received so startup is immediate and offline-safe; the laptop remains
authoritative.

## Consequences

- Security-critical code can use platform primitives directly.
- iOS uses platform security and interface primitives directly.
- Protocol conformance tests prevent drift between Swift and TypeScript.
- Native iOS background restrictions apply, and the current relay has no push
  notification subsystem.
- The iOS application can run from Xcode. Private TestFlight distribution is an
  external Apple workflow; there is no public App Store release in this repository.
