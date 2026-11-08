# Readnote Atlas Product Brief (v0.3)

## Product promise

**Understand English in context. Keep only what becomes yours.**

Readnote Atlas is not a translation archive and not a generic summarizer. It is a reading layer for source material and a capture path into a user-owned knowledge base.

## Primary loop

`Source → bilingual understanding → precise selection → personal note → Obsidian / Notion`

The loop is identical for text and video. A video timestamp plays the same role as a paragraph anchor on an article page.

## Experience principles

1. **The source remains primary.** Translation appears beside or over the source, never as a disconnected replacement.
2. **Progressive work.** Bilingual playback translates the active subtitle plus a bounded window ahead of the playhead; once a video's captions load, its overview begins in parallel so the first side-panel view is already useful.
3. **Precise capture before synthesis.** Notes preserve the exact excerpt, source URL, title, and timestamp before AI cleanup or commentary.
4. **User-owned memory.** Local storage is the safety net; Obsidian and Notion are destinations chosen by the user.
5. **Quiet interface.** The Readnote visual language uses dark ink, paper-white surfaces, restrained blue actions, and pale-yellow selection; shadows, rounding, and decoration recede while reading or watching.

## Information architecture

- **Original surface**
  - Article: inline translation and selection toolbar.
  - Video: bilingual player subtitles and a low-friction bookmark action.
- **Side panel**
  - Overview: the default tab, automatically generating one comprehensive Chinese account of the full discussion.
  - Notes: bookmarks, selected source passages, and free-form thoughts with knowledge sync state.
  - Transcript: complete, searchable, bilingual, playback-aware semantic paragraphs.
  - Library: videos with at least ten minutes of cumulative foreground playback.
- **Settings**
  - Transcript provider: Supadata.
  - Switchable video AI profiles: DeepSeek, OpenAI, Google Gemini, OpenRouter, or a custom OpenAI-compatible endpoint.
  - Personal knowledge base: local companion, Obsidian path, optional Notion page.
  - Local data controls and privacy explanation.

## Desktop listening model

Cross-app captions use an optional macOS native helper on loopback port 8792, paired to Readnote Atlas. Keep the helper running while listening outside YouTube.

| User action / state | Expected native caption behavior |
| --- | --- |
| Watch the source YouTube page | Hide the native window; preserve the existing player experience |
| Leave the source tab, switch apps, or minimize Chrome during playback | Show one always-on-top caption window |
| Pause an already-visible window | Keep the last caption and controls available |
| Return to the source YouTube page | Hide the window |
| Close the floating window | Suppress it until the user returns to the source page |
| Resize the window | Reflow and auto-fit both languages; retain left alignment and half-line spacing |
| Hover the window | Reveal proportional ±15-second seek, play/pause, bookmark, and close controls |

The surface uses neutral graphite translucency, white English, pale-yellow Chinese, and subtle hover dimming. Native ownership suppresses browser PiP to avoid duplicate boxes. After quitting the helper, refresh YouTube to restore the browser-only fallback.

## Setup and current boundaries

- Local annotations and saved video notes do not require a knowledge-sync destination.
- YouTube AI features require Supadata plus a configured video AI provider; automatic loading and pretranslation can incur provider usage.
- Article translation and Obsidian/Notion sync use the separate optional knowledge companion on port 8791.
- Native desktop captions require macOS, Node.js, Apple Command Line Tools, and a running paired helper. This distribution does not provide native auto-start or a Windows/Linux desktop helper.
- Translation scheduling minimizes waits, but network/provider latency and uncached seeks are not guaranteed to be instantaneous.
- Watched Library counts foreground playback, not background listening. Shorts, live streams, private videos, and videos without native captions remain outside this release.

## v0.3 acceptance criteria

- A user can watch a captioned English YouTube video with in-player Chinese support.
- Bilingual translation has one predictable On / Off state, and player subtitle typography and position are adjustable without permanently covering the video.
- A user can inspect and search the complete transcript without losing playback position.
- A user can select a transcript passage and save a timestamped note.
- The saved note remains available locally if every external service is offline.
- When configured, the same note is appended to Obsidian and Notion with a playable timestamp link.
- Article highlights continue to use the same knowledge destination.
- Article translation has a direct, reversible T / ✓ visibility toggle. Hiding translations preserves annotations and cache, pauses subsequent requests, and keeps late results hidden.
- Annotation deletion is separate from reading display, names the page scope, and requires confirmation.
- A video enters the Watched Library only after ten minutes of actual visible playback; seeking does not inflate watch time.
- Atlas supports article/video workflows and desktop transport. Native desktop rendering and knowledge sync use their respective optional local processes.
- When the helper is running, leaving the YouTube tab or minimizing Chrome shows one always-on-top caption box, and returning to YouTube hides it.
- The helper box stays visible while paused until the user dismisses it, and exposes proportional seek, playback, bookmark, drag, and resize controls.
- Documentation clearly distinguishes required extension setup from optional companion and desktop-helper setup.
