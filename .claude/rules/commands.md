---
paths:
  - 'packages/commands/**'
  - 'packages/slide-model/src/**'
---

# Command registry (ADR 0010)

- A new slide-model export is classified in
  `packages/commands/src/parity/slideModelExports.ts` (writer / reader); a
  writer needs a command that names it in `implementedWith`, or an entry in
  `parity/knownMissing.ts` (with its phase) or `parity/allowlist.ts` (with a
  reason).
- Examples are model-facing documentation and run in `contract.test.ts`
  against the fixture deck (`testing/fixtureDeck.ts`, ids fixed — add to it,
  never rename) and the fake services (`testing/fakeDomainServices.ts`, which
  must behave like the real service: same validation, same errors).
- A server command's validation belongs in the service it calls (every
  caller passes through there: routes, commands, other services).
- After a change: `just capabilities` (commit the manifest and the plugin),
  and the MCP tools/list budget (`apps/server/src/mcp/toolListBudget.test.ts`)
  — during A2 it rises per step with a measured, dated note.
