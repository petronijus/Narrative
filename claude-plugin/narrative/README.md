# narrative — Claude Code plugin

The `narrative` skill teaches Claude Code how to work with Narrative decks
through Narrative's MCP server: read and address decks, make targeted edits,
find and replace, translate, shorten and restyle — the Woodgrove way.

## Install

```text
/plugin marketplace add petronijus/Narrative
/plugin install narrative@narrative
```

Then connect the MCP server itself (the skill only teaches Claude how to use
it): create a token with the `mcp` scope in Narrative → account menu →
**Access tokens**, and register the server as the skill's "Setup" section
shows. claude.ai users add Narrative as a custom connector instead; they get
the same playbooks as MCP prompts from the server and need no plugin.

## Updating

The plugin's version is the Narrative release it shipped with, so every
release is an update for Claude Code:

```text
/plugin marketplace update narrative
/plugin update narrative@narrative
```

New Narrative tools reach a running session only when its MCP connection is
made again: `/mcp` → `narrative` → Reconnect (reloading plugins does not
reconnect MCP servers), or start a new session.

## Where it comes from

`skills/narrative/` is GENERATED from the playbooks in
`packages/commands/playbooks/` — the same files the MCP server serves as
prompts. Do not edit it by hand: change the playbook and run

```bash
pnpm --filter @narrative/commands skill
```

The same command writes `.claude-plugin/plugin.json` with the release
version from the root `package.json`. A test in
`pnpm --filter @narrative/commands test` fails when the committed skill or
manifest is stale — after a version bump, too.
