---
id: remotion-music-ducking
title: Add music under a voiceover without drowning it out
recipeFor: remotion
category: video
status: draft
author: Plado Originals
license: CC0-1.0
updated: 2026-09-28
---
Use the Remotion skill. Add background music from ${MusicFile:./public/music/bed.mp3} to ${Composition:MainVideo}, which already has a voiceover.

1. Don't replace the existing audio track. Mix the music under it. Replacing the audio silently deletes the voiceover, and nothing in a still frame or the file size would show it.
2. Duck the music by about 12 to 15 dB whenever the voice is speaking, with short fades (around 150ms in, 400ms out) so the dips aren't noticeable.
3. Fade the music in over 1 second at the start and out over 2 seconds at the end.
4. Add an end card from ${EndCard:./public/endcard.mp4} after the last frame, and keep the music under it.
5. If the music is licensed, check that its license file is in the project, and say so if it's missing.

Render the full video and confirm the voiceover is audible from start to finish.
