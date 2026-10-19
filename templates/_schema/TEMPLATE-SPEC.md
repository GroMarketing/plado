# Plado Template Spec (v0)

Each template is one Markdown file: `templates/<category>/<slug>.md`.
The frontmatter is the data the site indexes, and the body is what the user copies.

## Frontmatter
```yaml
---
id: video-ugc-ad-script-30s          # unique; <category>-<slug>
title: 30-second UGC ad script
category: video                      # must match the folder name
subcategory: ad-scripts
tools: [claude, chatgpt, grok, gemini]   # claude | claude-code | chatgpt | codex | grok | gemini | cursor | midjourney | ...
type: prompt                         # prompt | system-prompt | claude-skill | subagent | claude-md | workflow
inputs:                              # the {{variables}} the user fills in
  - name: product
    description: What you're selling, one line
  - name: audience
    description: Who it's for
difficulty: beginner                 # beginner | intermediate | advanced
tags: [ads, ugc, short-form]
tested: false                        # true only after the output was checked on each listed tool
version: 1
updated: 2026-09-28
license: plado-standard
---
```

## Body sections
1. **What it does.** One or two sentences.
2. **Template.** The copyable text, with `{{variables}}` for inputs.
3. **Example output.** A real output from a test run (required before `tested: true`).
4. **Tool notes** (optional). Per-tool tweaks, e.g. how the Claude Code skill version differs.

## Rules
- One job per template. If you need "and" to describe it, split it.
- Every `{{variable}}` has to be listed in `inputs`, and every input has to be used.
- `tested: true` means someone ran it on every tool in `tools` and the example output is real.
