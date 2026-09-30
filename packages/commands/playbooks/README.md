# Playbooks

Instructions for an AI agent that drives Narrative through its commands.
They are Narrative's own, written with the Woodgrove skill library presentation
skills as inspiration (docs/plans/agentic-layer.md §4.4, §8).

The same files feed two surfaces, so they never drift apart:

- the **MCP server** serves each playbook as an MCP _prompt_ (claude.ai and
  Claude Code users get them without installing anything);
- the **`narrative` Claude Code skill** is generated from them.

## Format

One Markdown file per playbook, with YAML frontmatter:

```yaml
---
name: edit # MCP prompt name; lower-kebab-case, unique
title: Targeted edits # human label
description: One sentence for the prompt picker.
arguments: # optional MCP prompt arguments
  - name: request
    description: What the user wants changed.
    required: true
  - name: scope # optional arguments may carry a default
    description: '"deck" (default) or a slide reference.'
    required: false
    default: deck
---
```

Every `{{argument}}` placeholder in the body must be a declared argument
and every declared argument must be used; the name must match the file
name. An optional argument that is not given becomes its `default`, or
`(not given)`. `packages/commands/src/playbooks/playbooks.test.ts` checks
all of this, plus the rule on command names below.

The body is written for a model. `basics.md` is the foundation every other
playbook assumes (it takes no arguments); the MCP server prepends it to each
prompt, and also serves every playbook as an MCP resource
(`narrative://playbooks/<name>`), so a model can read it on its own.

Write commands by their id (`query.deck`). Over MCP, and in the generated
skill, every mention is rewritten to the tool name the model sees
(`query_deck`: the id with dots replaced by underscores).

The loader is `@narrative/commands/playbooks` (Node only). The `narrative`
Claude Code skill is regenerated with
`pnpm --filter @narrative/commands skill` into the plugin that ships from
this repo, `claude-plugin/narrative/` (see `packages/commands/scripts/skill.ts`); never edit
the generated skill by hand — a test fails when it is stale.

## Rules for authors

- Name only commands that exist (see `docs/capabilities.md`). A planned
  command is written as "`x.y` (planned, not available yet)" together with
  today's workaround — the same rule the parity test enforces for command
  descriptions.
- Say what the agent must NOT do as clearly as what it should do.
- Keep them short. A playbook is read on every run; every sentence costs
  context.
