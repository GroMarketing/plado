---
id: remotion-readable-captions
title: Burned-in captions timed to reading speed
recipeFor: remotion
category: video
status: draft
author: Plado Originals
license: CC0-1.0
updated: 2026-09-28
---
Use the Remotion skill (the captions part). Add burned-in captions to ${Composition:MainVideo} from ${CaptionSource:./captions.srt}.

Rules:
1. Show at most 2 lines and about 32 characters per line. Break lines at natural phrase boundaries, not mid-phrase.
2. Every caption stays on screen long enough to read: at least (characters / 15) seconds, and never under 1 second. If the source timing is shorter, merge it with the next caption instead of flashing it.
3. Place captions inside the safe zone, above the bottom 360px on vertical video, so platform buttons don't cover them.
4. White text with a dark outline or a semi-transparent box, at least 44px on a 1080-wide frame, with 4.5:1 contrast.
5. Highlight the word currently being spoken only if word-level timing exists in the source; otherwise keep captions static.

Render a 20-second preview and list any captions you merged or retimed.
