---
id: remotion-stat-cards
title: Animated stat cards that don't mislead
recipeFor: remotion
category: video
status: draft
author: Plado Originals
license: CC0-1.0
updated: 2026-09-28
---
Use the Remotion skill. Make a reusable StatCard composition that shows ${Count:3} statistics from ${DataFile:./data/stats.json}, each with a label and a source line.

Requirements:
1. Numbers count up from 0 over about 0.8 seconds with an ease-out curve. Ranges and composite values (like "$10-20K") stay static; don't animate them.
2. Draw comparison bars only when all the numbers share one unit. If units differ, show the numbers without bars rather than implying a comparison.
3. Every stat shows its source in small text. Never display a number without one.
4. Hold the card for the time it takes to read the longest line at 15 characters per second, plus 0.4 seconds for each extra line, plus 1 second, after the count-up finishes.
5. Size text for phones: the number at least 120px, the label at least 44px, and keep everything inside the safe zone for ${Format:vertical 1080x1920}.

Export StatCard so other compositions can reuse it, and add a test that fails if a card's hold is shorter than its reading time.
