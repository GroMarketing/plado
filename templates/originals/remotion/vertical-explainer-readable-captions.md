---
id: remotion-vertical-explainer
title: Vertical explainer reel with text people can actually read
recipeFor: remotion
category: video
status: draft
author: Plado Originals
license: CC0-1.0
updated: 2026-09-28
---
Use the Remotion skill. Build a 1080x1920 vertical explainer video about ${Topic:how our product saves time} for ${Audience:small business owners}.

Structure it as 5 to 7 beats: a hook, the problem, 2 or 3 points, one proof point, and a call to action that says "${CTA:Try it free}".

Rules:
1. Frame one must carry a word the audience identifies with (for example "${AudienceWord:owners}") plus a hook: a question, a surprising number, or a statement that opens a loop. Don't spend frame one on a logo.
2. Hold every text beat long enough to read with the sound off. Hold time = (characters / 15) seconds + 1 second, counted after the entrance animation has settled. For cards with several lines, time the longest line and add 0.4 seconds per extra line.
3. Keep all text inside a safe zone of 220px top, 360px bottom, 60px left and 180px right, so Reels, Shorts and TikTok buttons don't cover it.
4. Body text at least 44px, headlines at least 80px, with 4.5:1 contrast against the background.
5. One idea per beat. No beat with more than 12 words of body text.

Put the timing rule in one shared helper and make the build fail if any beat is shorter than its computed hold. Then render a preview and list each beat with its hold time so I can check it.
