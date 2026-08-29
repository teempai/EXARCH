## Summary

Describe the user-visible change and why it is needed.

## Security boundary

Describe any effect on authentication, pairing, encryption, relay behavior,
project authority, provider execution, approvals, Keychain access, or stored
context. Write `No boundary change` only after checking `SECURITY.md`.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Relevant Swift tests/builds
- [ ] Failure paths and user-visible errors tested
- [ ] Documentation updated when behavior or assumptions changed
- [ ] No credentials, private data, personal paths, or raw conversations included
