---
id: remotion-crisp-render
title: Render settings that keep text sharp on YouTube and Reels
recipeFor: remotion
category: video
status: draft
author: Plado Originals
license: CC0-1.0
updated: 2026-09-28
---
Use the Remotion skill. Check and fix this project's render settings so text stays sharp after ${Platform:YouTube} re-compresses the video.

1. In remotion.config.ts, capture frames as PNG, not JPEG. JPEG frame capture blurs thin text on dark backgrounds before the video is even encoded.
2. Set CRF to 16, color space to bt709 and pixel format to yuv420p.
3. If any step re-encodes with ffmpeg afterwards (adding music, an end card), use: -crf 16 -preset slow -pix_fmt yuv420p, bt709 color tags, and -movflags +faststart.
4. Tell me which existing videos were rendered with the old settings. Re-encoding a blurry file won't fix it; those need to be re-rendered from source.

Show me the config diff, render a 5-second test of ${TestComposition:the title card}, and report the output bitrate.
