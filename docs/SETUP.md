# Local installation and pairing

This is the self-hosted setup for the locally ad-hoc-signed developer prototype. EXARCH has
no vendor signup, hosted account, or identity service. The user chooses a
compatible relay and supplies its address during setup. It does not require
Tailscale, a router rule, or a public port on the Mac; the Mac and phone both
connect outbound.

## 1. Provide the relay

The relay must expose both HTTPS and WebSocket upgrade traffic on one public
TLS hostname. Its application endpoint is exactly `/v1/relay`; management uses
`/v1/routes` and `/v1/tickets`. TLS termination may be supplied by the hosting
platform or a reverse proxy. Do not expose the Node service directly to the
Internet without TLS. When the service binds a non-loopback address it refuses
to start unless `EXARCH_RELAY_TRUST_PROXY=1` is set. In that mode, the service also
rejects credential-bearing HTTP routes and WebSocket upgrades unless the
trusted proxy supplies `X-Forwarded-Proto: https`. The application port must
therefore be reachable only from that proxy; never expose it as a second public
plaintext port where clients could forge proxy headers.

Generate two independent credentials:

```text
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

Set the first as `EXARCH_RELAY_SECRET` and the second as
`EXARCH_RELAY_ADMIN_TOKEN`. Set `EXARCH_RELAY_STATE_PATH` to an absolute path
on durable storage (for example `/data/relay-state.json`); this file records
revoked route IDs so a relay restart cannot restore a removed phone's access.
Also set `EXARCH_RELAY_HOST=0.0.0.0` and
`EXARCH_RELAY_PORT=8787`, and set `EXARCH_RELAY_TRUST_PROXY=1` only after configuring
the platform's HTTPS-terminating proxy. Fly Proxy is compatible with this
contract: use its HTTP service with HTTPS forced, and keep the Machine's
application port private. Build and run `Dockerfile.relay`, then verify
`https://your-host/health` returns `{"status":"ok"}`. The Mac app never stores
the administrator token. Keep it in an operator-owned password manager for
later pairing, or rotate it after pairing and set a new value before
provisioning another route. Never commit either relay secret.

## 2. Install the Mac companion and service

Requirements are macOS 14 or newer, Xcode, its command-line tools, and Node.js
22 or newer. From this checkout:

```text
./scripts/install-macos.sh
```

The installer builds the optimized app, native Keychain helper, and native
`EXARCH Service` supervisor. It embeds the supervisor in the app, applies a
local ad-hoc signature, installs the app to `~/Applications/Exarch Desktop.app`,
installs a per-user LaunchAgent, initializes the encrypted laptop context, and
stages the Node runtime under `~/Library/Application Support/EXARCH/runtime`.
It does not use administrator privileges and starts in an explicit unpaired
state. Runtime
launchers use `/bin/sh`, the service PATH excludes `~/.local/bin`, daemon Git
checkpoints invoke `/usr/bin/git` directly, and a successful reinstall retains
at most one rollback copy of the prior app and runtime.

The LaunchAgent starts `EXARCH Service`, which remains the responsible macOS
process while supervising the internal Node daemon. Protected-folder and
cross-application permission prompts are therefore attributed to EXARCH rather
than to a generic Node executable. Local signatures can change after a rebuild,
so macOS may ask again during development. This checkout has no stable Apple
distribution identity.

For the ad-hoc-signed prototype, an upgrade moves the already Keychain-authorized
helper inode into the new runtime and retains the rebuilt helper as
`exarch-keychain.next`. Replacing an ad-hoc-signed helper outright would make
existing local Keychain items inaccessible. The preserved helper is the current
prototype's continuity mechanism.

Open the Mac app. The empty conversation pane reports which harnesses it finds
while the service imports their native histories. The process disappears after
the initial scan, and imported threads populate the sidebar. Settings shows the
current harness results and provides **Scan again**.

EXARCH deliberately does not ship with a built-in relay address. Choose
**Pair phone** in the main window, enter the operator or self-hosted relay URL
in the form `wss://your-host/v1/relay` and its administrator token, then create
the one-use QR/paste pairing code. This is the current OSS product flow; see ADR
0012.

After installation, the main Mac window is also a local desktop client. It uses
the same canonical conversations, harness-switch confirmation, laptop policy,
model selection, approvals, capacity status, and laptop-owned per-thread
fallback routes as the phone. It reaches only the signed loopback API and
initially loads the 30 most recent visible messages, with older messages loaded
on demand. The relay is not involved in Mac-to-daemon traffic.

## 3. Install the iPhone app

Run:

```text
./scripts/open-ios-project.sh
```

In Xcode, select the `EXARCH` target, choose your Apple Development
team, choose the connected iPhone, and press Run. A personal development team
can be used for private testing; its provisioning lifetime is controlled by
Apple. This repository does not automate TestFlight or App Store distribution.

## 4. Pair

On the iPhone, tap **Scan QR** and scan the one-use code shown by the Mac. The
camera scan starts the secure connection automatically. **Paste** and the
editable invitation field remain available as fallbacks, including in
Simulator where camera scanning is unavailable. Compare the 18-digit code on
both devices and accept it on each. Simulator builds use development-only
software device keys because Secure Enclave and biometric key authorization are
not reliably available there. Physical iPhone builds continue to use the
hardware Secure Enclave and biometric approval path.
The relay access capability is delivered to the phone only inside the confirmed
Noise channel. The Mac stores its private credentials and database key in the
macOS Keychain; the iPhone stores its keys and route in Keychain/Secure Enclave.

If an outbound-connection monitor blocks the first attempt, allow both the Mac
companion runtime and the iOS app or Simulator to reach the configured relay, then
create a fresh pairing code. Pairing tickets are one-use, so retrying a code
after a partially established or closed WebSocket is intentionally rejected.

The Mac service is already running after installation. Enroll each directory
that either client may use for agent work from a terminal on the Mac:

```sh
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" \
  project-add --name "My project" --repo-root /absolute/path/to/project
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" projects
```

Project enrollment is deliberately laptop-local. The phone can select an
enrolled project but cannot submit or broaden a filesystem path. Create a
conversation on iPhone, choose Codex, Claude Code, or Hermes, and leave the
model field blank to use the harness's laptop default (or enter a
provider-supported model identifier).

On each daemon start, the Mac first copies existing interactive Codex threads,
top-level Claude Code transcripts, and Hermes sessions into the encrypted local
canonical store. This operation is read-only and idempotent. Claude transcript
files are then watched continuously: changed files are debounced for two seconds
and reimported individually. Mobile conversation synchronization schedules a
non-blocking Claude file-inventory check when the previous check is more than ten
seconds old, and the daemon performs a complete all-provider reconciliation every
five minutes. The phone always receives the current canonical page immediately;
native scanning does not block the relay response.

Imported threads appear in the same iPhone conversation list as newly created
threads. Claude imports preserve the latest native custom or AI title and use the
session's first recorded working directory as stable project metadata. A project
discovered only through history is browse-only. To resume work there, enroll its
exact directory with `exarch-setup project-add`; an imported thread whose project
was already explicitly enrolled reuses that scope. The phone cannot supply or
broaden this path. EXARCH application state under
`~/Library/Application Support/EXARCH` remains forbidden as a project, while an
ordinary source repository named `EXARCH` is allowed. The authenticated
`GET /api/v1/history-import/status` endpoint reports per-provider results;
`POST /api/v1/history-import/refresh` accepts an explicit full refresh with
HTTP 202 and returns its initial running status. Clients poll the status endpoint
until the laptop reports `complete`, `partial`, or `failed`, so large native
histories do not hold a relay or loopback request open.

## Operation and removal

Provider authentication remains exactly where the provider installed it on the
Mac. The phone cannot change the provider's approval policy; tapping the policy
badge shows the observed project-specific effective mode and revision. Harnesses
that are not installed or do not match the supported protocol version appear as
unavailable and cannot be selected. Provider approval prompts are relayed with
their native choices and require the separate approval key on the phone.

While a turn is active, the top-right action becomes **Interrupt**.

Logs are in `~/Library/Application Support/EXARCH/logs`. The phone-pairing
sheet shows copyable redacted activity. To uninstall, run
`./scripts/uninstall-macos.sh`.
The uninstaller moves the app, runtime, configuration, and encrypted context to
Trash so recovery remains possible. Keychain items are intentionally retained
and are not removed by the uninstall command.

Both apps expose **Remove pairing**. The phone action is authenticated with the
device owner policy on physical devices. The laptop action requires macOS user
authentication. Either path first writes a durable pending-revocation state and
revokes the phone's request and approval identity in the encrypted laptop
database. The phone deletes its pairing record, request counter, device keys,
transport key, cached thread index, and cached message pages only after the Mac
acknowledges that local authority withdrawal. The daemon then uses the host-only
relay capability to retire the complete route and close live sockets. Failed
relay cleanup is retried and resumes after daemon restart; paired configuration
and the host route credential are cleared only after retirement succeeds.
Canonical conversations and imported context remain encrypted on the laptop and
are reused after a later pairing.

If the phone is unavailable, use the Mac app or the local setup CLI:

```sh
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" unpair
```

To inspect or revoke only a paired request and approval identity without
retiring the route, use:

```sh
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" devices
"$HOME/Library/Application Support/EXARCH/runtime/bin/exarch-setup" \
  revoke --device-id device_...
```

Device-only revocation is committed to the encrypted laptop database and takes effect on
the next challenge, signed request, or approval decision, including requests
using a challenge issued before revocation. Prefer `exarch-setup unpair` when
removing the only phone, because it also retires the relay route.

## Current distribution boundary

The code and automated interoperability path are functional. The Mac checkout
is not Developer ID signed or notarized. The iOS app can run from Xcode; private
TestFlight builds have also been used, but this repository does not automate or
reproduce Apple distribution. The current same-user Keychain helper boundary
and other residual risks are documented in `SECURITY.md`.
