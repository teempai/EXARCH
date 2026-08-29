# EXARCH

EXARCH is a native macOS and iOS interface for controlling Codex, Claude Code,
and Hermes on your own Mac. Conversation history, repository state, provider
credentials, approvals, and the canonical context store remain on the Mac.

EXARCH is self-hostable and has no product account, Sign in with Apple flow,
allowlist, billing system, or required VPN. You choose the compatible relay used
to connect the phone and Mac. The relay forwards opaque end-to-end-encrypted
frames and cannot read conversation content or authorize laptop actions.

> [!WARNING]
> EXARCH is a developer prototype that can remotely run mutation-capable coding
> agents. The Mac installer applies only a local ad-hoc signature; it is not
> Developer ID signed or notarized. Read
> [the security boundary](SECURITY.md) before using it with important data.

## What you need

- A Mac running macOS 14 or newer
- Xcode and its command-line tools
- Node.js 22 or newer
- At least one supported harness installed and authenticated on the Mac:
  Codex, Claude Code, or Hermes
- A public TLS relay. You may deploy the included relay or use a compatible
  relay supplied by someone you trust.
- An iPhone running iOS 17 or newer, or the iOS Simulator for development

## Quick start

### 1. Clone and install dependencies

```sh
git clone https://github.com/teempai/EXARCH.git
cd EXARCH
npm ci
```

Confirm that Node is new enough with `node --version`. If macOS resolves an old
Node first, invoke npm with the directory containing your Node 22+ installation
at the front of `PATH`. On an Apple Silicon Mac with Homebrew, for example:

```sh
export PATH="/opt/homebrew/bin:$PATH"
node --version
npm --version
```

### 2. Deploy a relay

The included Fly.io configuration is the shortest tested route to a public TLS
relay. Install `flyctl`, authenticate, choose a globally unique app name and a
nearby Fly region, then run:

```sh
fly apps create YOUR_EXARCH_RELAY
fly volumes create exarch_relay_data --app YOUR_EXARCH_RELAY --region hel --size 1
node -e 'const {randomBytes}=require("node:crypto"); console.log("EXARCH_RELAY_SECRET="+randomBytes(32).toString("base64url")); console.log("EXARCH_RELAY_ADMIN_TOKEN="+randomBytes(32).toString("base64url"))'
```

Save both generated values outside the repository. Set them on Fly and deploy:

```sh
fly secrets set --app YOUR_EXARCH_RELAY EXARCH_RELAY_SECRET='YOUR_RELAY_SECRET' EXARCH_RELAY_ADMIN_TOKEN='YOUR_ADMIN_TOKEN'
fly deploy --app YOUR_EXARCH_RELAY --config fly.relay.toml
curl https://YOUR_EXARCH_RELAY.fly.dev/health
```

The health response is `{"status":"ok"}`. Your pairing address is:

```text
wss://YOUR_EXARCH_RELAY.fly.dev/v1/relay
```

The volume preserves route revocations across restarts. Keep the administrator
token in a password manager if you expect to pair again; EXARCH itself does not
store it. `EXARCH_RELAY_SECRET` must remain stable for existing route
capabilities. See [Relay setup and hardening](docs/SETUP.md#1-provide-the-relay)
for non-Fly deployments and the trusted-proxy requirements.

### 3. Install the Mac app and background service

```sh
./scripts/install-macos.sh
open "$HOME/Applications/Exarch Desktop.app"
```

The installer uses no administrator privileges. It initializes the encrypted
laptop store and starts the per-user background service without requiring a
phone or relay. On first open, the main EXARCH window discovers Codex, Claude
Code, and Hermes and imports their existing threads.

### 4. Run the iPhone app

```sh
./scripts/open-ios-project.sh
```

In Xcode:

1. Select the `EXARCH` iOS target, not `EXARCHMac`.
2. Choose your own Apple Development team under **Signing & Capabilities**.
   The repository intentionally does not commit a development-team identifier.
3. For device builds outside the official EXARCH team, choose a unique bundle
   identifier owned by your team.
4. Choose a connected iPhone or an iPhone Simulator as the run destination.
5. Press **Run**.

The Simulator supports pasted pairing codes but cannot scan the Mac's QR code.
A physical iPhone uses Secure Enclave and device authentication where
available; Simulator builds use development-only software keys.

### 5. Pair

In the Mac client, choose **Pair phone**, enter the relay address and
administrator token from step 2, and create a pairing code. On iPhone, scan the
QR code or paste the pairing code. Compare the 18-digit code on both devices
and accept it on both. The phone then loads the existing Codex, Claude Code,
and Hermes threads imported into the encrypted laptop store.

If a firewall or outbound-connection monitor blocks the first attempt, allow
EXARCH and the iOS app or Simulator to reach your relay, create a fresh pairing
code, and retry. Pairing codes are intentionally one-use.

### 6. Add a project for new conversations

Imported native threads retain their historical working directory for display
and provider-session provenance, but history import alone does not authorize
execution there. Enroll an allowed project from the Mac before resuming an
imported thread or creating a new conversation in that directory:

```sh
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" \
  project-add --name "My project" --repo-root /absolute/path/to/project
```

The phone can choose an enrolled project but cannot create or broaden a
filesystem scope.

### 7. Use the desktop client

The Mac application has one main window. On a new encrypted store, its empty
conversation pane shows live harness discovery and native-history import
results, then gives way to the imported thread list. **Settings** shows the
current harness results and provides **Scan again**. **Pair phone** opens the
relay, QR/paste, 18-digit verification, and copyable terminal-style activity
flow in a sheet.

The client uses a signed, authenticated loopback connection to the local daemon
and works without a phone pairing. The sidebar sorts pinned threads first; pin
state is owned by the laptop and synchronized with the iOS client. It loads only
the latest 30 messages initially and retrieves older pages when requested.
Sending is optimistic: the message remains visible while the laptop provider
works.

The desktop client creates conversations in enrolled projects, selects threads,
switches provider after confirmation, chooses a model, interrupts a turn,
answers provider approvals, retries on another healthy harness after a capacity
error, pairs or unpairs the phone, and switches between light and dark
appearance. Each thread can persist an ordered fallback route in Settings.
When a harness reports exhausted capacity before accepting a message, the
client advances to the next configured healthy harness and retries that same
message once; all other failures stop for the user.

## Everyday operation

- The Mac must be awake and the EXARCH service must be running.
- Provider login and approval policy remain exactly where each harness stores
  them on the Mac.
- The clients show the observed policy but cannot weaken or edit it.
- Text and voice submit the same canonical text message. Voice only adds native
  speech recognition and final-response playback.
- Existing provider history is imported read-only and reconciled in the
  background.
- Removing the pairing durably revokes phone authority first, then retires the
  complete relay route with retryable cleanup while keeping canonical context
  on the Mac.

Useful commands:

```sh
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" status
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" devices
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" unpair
./scripts/uninstall-macos.sh
```

Logs are stored under `~/Library/Application Support/EXARCH/logs`. Uninstalling
moves the application, runtime, configuration, and encrypted context to Trash
so they remain recoverable.

## How it is structured

- The laptop is the execution host and canonical data owner.
- The macOS app provides setup, device management, and a local desktop client.
- The iOS app keeps a protected offline replica of data it has already received
  and synchronizes deltas when opened.
- The daemon exposes an authenticated loopback API and supervises providers.
- The user-selected relay sees routing and traffic metadata but only opaque
  encrypted frames.
- Agents retrieve older canonical context through a bounded, turn-scoped local
  CLI rather than receiving the entire history in every prompt.

## Development and verification

```sh
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:native-interop
npm run test:installer
swift test --package-path native
xcodebuild -project native/EXARCH.xcodeproj -scheme EXARCHMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/exarch-derived CODE_SIGNING_ALLOWED=NO build
```

Some integration tests create loopback or Unix sockets and need normal local
execution permissions. The currently verified surface is tracked in
[Implementation status](docs/IMPLEMENTATION_STATUS.md).

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md). Security-sensitive
changes should preserve the boundaries in [SECURITY.md](SECURITY.md), include
tests for failure paths, and avoid committing credentials or private user data.

## Documentation

- [Product and technical specification](SPEC.md)
- [Current security boundary](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Public-release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Detailed installation and pairing](docs/SETUP.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [User-selected relay decision](docs/adr/0012-user-selected-relay-provisioning.md)
- [Canonical provider-history import](docs/adr/0009-canonical-history-import.md)
- [Offline-first mobile cache](docs/adr/0010-offline-first-mobile-thread-cache.md)
- [Laptop-authoritative project enrollment](docs/adr/0011-laptop-authoritative-project-enrollment.md)
- [Visual style guide](docs/design/STYLE_GUIDE.md)

The remaining architecture decisions are under [`docs/adr`](docs/adr).

## License

EXARCH is licensed under the [Apache License 2.0](LICENSE).
