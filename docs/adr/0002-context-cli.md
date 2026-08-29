# ADR 0002: Expose stored context through a local CLI

Status: Accepted

## Context

Codex, Claude Code, and Hermes can run local commands. EXARCH needs bounded
context search and retrieval but does not need the discovery and transport
features of an MCP server.

## Decision

Provide a non-interactive `exarch-context` CLI. It communicates with the laptop
daemon over a Unix socket using a short-lived, turn-scoped capability. It offers
bounded, machine-readable commands for current state, recent history, search,
events, decisions, tasks, repository checkpoints, and handoff records.

The CLI does not expose arbitrary SQL, deletion, credential access,
cross-project queries, or general shell execution. Validated append-only
decision and task mutations are available only to authorized local callers;
provider prompts receive read-only capabilities.

## Consequences

- The interface is universal, directly testable, and easy to debug manually.
- Shell quoting, stdout bounds, exit codes, and JSON schemas require careful
  design.
- Agents need explicit instructions and examples because CLI commands are less
  discoverable than typed MCP tools.
- The context interface is deliberately smaller than an MCP server.
