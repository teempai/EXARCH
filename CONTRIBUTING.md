# Contributing to EXARCH

EXARCH can remotely run mutation-capable coding agents, so changes at a trust
boundary need the same care as changes to authentication or credential code.
Please start with the smallest coherent change and include tests for both the
success and failure paths.

## Development setup

You need macOS 14 or newer, Xcode and its command-line tools, and Node.js 22 or
newer.

```sh
npm ci
npm run typecheck
npm test
npm run build
swift test --package-path native
```

For the native app, open `native/EXARCH.xcodeproj` and select your own Apple
Development team. Do not commit a personal or organization team identifier.
Device builds from another team also need a unique bundle identifier owned by
that team; do not replace the official identifier in a general-purpose pull
request.
Unsigned macOS verification does not require signing:

```sh
xcodebuild -project native/EXARCH.xcodeproj -scheme EXARCHMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/exarch-derived CODE_SIGNING_ALLOWED=NO build
```

## Pull requests

- Explain the user-visible behavior and security impact.
- Add or update tests for changed behavior and failure handling.
- Keep provider policy inherited from the native harness; clients may observe
  policy but must not weaken it.
- Preserve the loopback-only API, signed request envelopes, encrypted caches,
  laptop-authoritative project enrollment, and one-device relay model described
  in `SECURITY.md`.
- Do not include credentials, private repositories, real conversation history,
  personal filesystem paths, or identifying logs in commits or screenshots.
- Update documentation when behavior or a security assumption changes.

Run the complete verification list in `README.md` when the affected platform is
available. If a check cannot run, say exactly which check and why in the pull
request.

## Security reports

Do not disclose a suspected vulnerability in a public issue. Follow the private
reporting instructions in `SECURITY.md` and use synthetic reproduction data.
