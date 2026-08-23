# ADR 0001: The verifier is a runtime kernel, not a hook

Status: accepted
Date: 2026-08-22

## Decision

Build a standalone, local-first verification kernel with portable JSON contracts. Hooks and Codex skills may invoke it, but cannot implement or override its verdict.

The core is deterministic and domain-neutral. Legal, business messaging, and future products provide adapters and policy.

## Why

The previous legal verifier combined an instruction gate, a reviewer workflow, and a small regex preflight. That is useful process control, but it cannot verify claim-to-source closure or produce a replayable machine verdict.

A hook is also the wrong trust boundary:

- it runs only in one host;
- it is easy to confuse hook completed with content passed;
- it cannot be reused by a server, CI job, mobile app, or another agent;
- it tends to mix triggering, verification, editing, and transmission.

## Consequences

- The hook only triggers a CLI call and preserves fail-closed behavior.
- The legal skill remains the workflow adapter and human audit format.
- The CLI writes trace artifacts but never sends, files, books, or executes tools.
- Semantic checkers and action executors are separate plugins.
- A runtime pass never authorizes an external action or communication.
