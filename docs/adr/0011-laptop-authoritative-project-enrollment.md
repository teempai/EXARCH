# ADR 0011: Keep project enrollment authoritative on the laptop

Status: Accepted

## Context

A paired phone controls providers that can read and modify files with the
authority configured on the laptop. If the mobile API accepts an arbitrary
repository root, possession of a phone key also becomes authority to select a
new filesystem target. Provider history creates a second laptop-local input,
but a transcript's recorded working directory is descriptive data rather than a
user authorization decision.

## Decision

Project scope is enrolled only through a laptop-local administrative path. The
mobile API lists projects but has no endpoint for creating projects or changing
their repository root or allowed paths. The iOS new-conversation screen offers
only execution-enrolled projects.

Laptop-local history synchronization records the native session's working
directory but does not enroll it. A newly discovered project receives an empty
execution scope and remains browse-only. If the same directory is already
enrolled, the imported conversation reuses that existing project. The phone
cannot select, submit, or broaden a path.

Running `exarch-setup project-add --name <name> --repo-root <absolute-path>` on
the Mac is the way to authorize a directory for new work or resume an imported
thread whose project is still browse-only.

## Consequences

- Pairing a phone does not authorize it to select new laptop directories.
- Native history readers can create only browse-only project records; remote
  requests cannot invoke even that operation.
- Imported threads retain stable project and conversation references but cannot
  execute until the corresponding directory is explicitly enrolled on the Mac.
- The user performs an explicit laptop action before any previously unenrolled
  workspace can run provider work.
- The current Mac and iOS conversation forms list existing enrollments and have
  no endpoint for changing their filesystem roots.
