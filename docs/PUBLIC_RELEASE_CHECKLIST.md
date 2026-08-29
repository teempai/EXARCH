# Public-release checklist

Changing repository visibility publishes more than the default branch. Complete
this checklist immediately before making EXARCH public.

## Repository history and metadata

- Scan every reachable Git object, not only the working tree, for credentials,
  private keys, pairing codes, private hostnames, user paths, and personal data.
- If history contains deleted private or product-planning material, do not assume
  deleting the current file hides it. Publish a reviewed clean snapshot in a new
  repository, rewrite every reachable ref, or explicitly accept the disclosure.
- Review commit-author names and email addresses. Rewrite history before the
  visibility change if any author does not consent to publication.
- Delete merged remote branches that should not remain public. Reconcile every
  unmerged branch first so unique work is either merged, preserved elsewhere,
  or intentionally discarded.
- Review issue, pull-request, review-comment, release, Actions-artifact, and wiki
  content for credentials and private user data.
- Rotate a credential if it ever entered Git or GitHub metadata; deletion alone
  does not make a disclosed credential safe.

## GitHub controls

- Enable private vulnerability reporting before inviting public security
  research. Verify that **Security → Report a vulnerability** works from an
  account without repository write access.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection where GitHub makes them available.
- Protect `main`: require pull requests, successful required checks, resolved
  review conversations, and protection for administrators.
- Restrict GitHub Actions to approved actions and require actions to be pinned
  to a full commit SHA.
- Enable automatic deletion of head branches after merge.

## Source and distribution

- Run the commands under **Development and verification** in `README.md` from a
  clean clone.
- Confirm that the Xcode project contains no committed development-team ID and
  that contributors can select their own team locally.
- Verify all generated or vendored material is identified in
  `THIRD_PARTY_NOTICES.md` and retains its required license text.
- Keep the first public release source-only unless distributed macOS binaries
  have a stable signing identity and notarization, and iOS builds have completed
  the normal App Store/TestFlight review path.
- Re-read `SECURITY.md` and `docs/IMPLEMENTATION_STATUS.md`; neither may imply a
  stronger guarantee than the verified implementation.

## Visibility change

- Take a recoverable backup or mirror of the private repository.
- Record the exact reviewed commit and repeat the history/metadata secret scan
  against that commit immediately before the change.
- Change visibility only as a separate, explicit maintainer action.
- From a signed-out browser, verify the repository contains only the intended
  branches, tags, issues, releases, documentation, and downloadable artifacts.
