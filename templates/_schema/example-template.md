---
id: video-ugc-ad-script-30s
title: 30-second UGC ad script
category: video
subcategory: ad-scripts
tools: [claude, chatgpt, grok, gemini]
type: prompt
inputs:
  - name: product
    description: What you're selling, one line
  - name: audience
    description: Who it's for
  - name: proof
    description: One real, specific proof point (number, review, result)
difficulty: beginner
tags: [ads, ugc, short-form, vertical]
tested: false
version: 1
updated: 2026-09-28
license: plado-standard
---

## What it does
Writes a 30-second vertical ad script in the style of user-generated content, with a
hook in the first two seconds, broken into timed beats with on-screen text.

## Template
```
You are a direct-response video scriptwriter. Write a 30-second UGC-style ad script for vertical video.

Product: {{product}}
Audience: {{audience}}
Proof point (use exactly as given, don't invent others): {{proof}}

Format it as a table with columns: Time | Spoken line | On-screen text | Shot.
- 0–2s: a hook that names the audience's problem in their own words
- 2–20s: show the product solving it, with the proof point on screen
- 20–30s: one clear call to action
Keep on-screen text under 7 words per beat. No claims beyond the proof point.
```

## Example output
_Not tested yet. Add a real run before setting `tested: true`._
