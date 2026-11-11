# Readnote Atlas

[简体中文](README.zh-CN.md)

**I built Readnote Atlas to help Chinese-native readers understand the English-speaking world, from text to video.**

Readnote Atlas keeps the original English in view while giving me the Chinese context I need. When I find something worth remembering, I can save the exact passage, timestamp, or thought and grow my own Obsidian or Notion knowledge base.

> Translation is a reading aid, not the destination.

[Install with an agent](#install-with-your-agent) · [What I can do](#what-i-can-do) · [First session](#my-first-session) · [Desktop captions](#listen-while-i-work) · [Privacy](PRIVACY.md)

## Install with your agent

I use a coding agent such as Codex or Claude Code to set Atlas up locally. Copy the prompt below into your agent and send it together with this repository URL. The agent can clone the project, install dependencies, build it, run the checks, and load the extension when browser control is available.

```text
Please set up Readnote Atlas from:
https://github.com/pheobepotato/readnote-atlas

Work through the setup end to end:
1. Clone or update the repository in my workspace.
2. Install dependencies with npm install.
3. Build and verify it with npm run check.
4. Load the repository as an unpacked Chrome extension from the folder containing manifest.json.
5. Open the Readnote Atlas settings page and tell me which API keys are needed for YouTube captions and AI translation.
6. Refresh any open YouTube and article tabs after loading the extension.

Keep API keys out of source files, logs, screenshots, and commits. Do not change product behavior. At the end, report the local path, extension ID, checks, and any step that still needs my manual approval.
```

If the agent cannot control my Chrome window, it should finish the local build and give me the one remaining Chrome step: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.

The faint **T** launcher sits along the right edge in the lower half of the page. Click **T** to translate; **…** means translation is running, and **✓** means translations are shown. Click again for original-only reading: highlights, notes and translation cache stay saved. Use the adjacent **⋯** menu to retry missing translations or explicitly delete this page’s annotations. The surrounding space stays clickable.

## What I can do

### Read

I open an English article and keep the original page in front of me. Atlas helps me translate readable paragraphs, highlight important lines, add annotations, and save source-linked excerpts.

### Watch

I open an English YouTube interview, lecture, or conversation. Atlas shows a centered English and Simplified Chinese subtitle layer directly over the player, while the side panel builds a Chinese Overview and a complete, selectable paragraph transcript.

The video workflow is designed around the moment I am watching:

- translations are prepared ahead of playback so the active subtitle can arrive quickly;
- after I seek, the new playback position gets priority;
- the subtitle box can be dragged and resized, with text reflowing to fit;
- **Overview → Notes → Transcript → Library** keeps the side panel easy to scan.

### Keep

I can click the small bookmark at a strong moment, select a transcript paragraph, or write my own thought. The note keeps its timestamp and source, so I can return to the exact context later. Notes are saved locally first and can be sent to Obsidian or Notion.

Videos enter my Watched Library after ten cumulative minutes of real foreground playback. It becomes a quiet record of what I have actually spent time learning.

### Listen while I work

On macOS, I can run the optional desktop caption helper. When a YouTube video keeps playing while I switch tabs, move to another app, or minimize Chrome, Atlas shows a compact translucent caption box above my work. Returning to YouTube hides it; hovering reveals playback, ±15-second seek, and bookmark controls.

```bash
npm run desktop:captions -- --extension-id=YOUR_READNOTE_ATLAS_ID
```

Pair it once with the extension ID shown in `chrome://extensions`. Later starts use `npm run desktop:captions`. See [the desktop caption guide](scripts/desktop-captions/README.md) for macOS requirements and troubleshooting.

## My first session

1. I open a captioned English YouTube video and start playback. Atlas begins preparing the transcript, translations, and Overview.
2. I read the bilingual subtitle over the player. I open Atlas below the player to see the Chinese Overview first.
3. I click the bookmark when a moment is worth keeping, or open **Notes** to write a personal thought.
4. I open **Transcript** to search, select, and save a meaningful paragraph. Its timestamp takes me back to the video.
5. I return to **Library** later to revisit videos that reached ten minutes of foreground playback.

For an article, I select a passage and choose the annotation or save action that fits the thought I want to keep.

## What I need for setup

The agent can handle the commands. These are the services Atlas connects to when I choose those features:

- Chrome 116+ and Node.js 22.19+;
- a Supadata API key for native YouTube transcripts;
- an API key for a video provider such as DeepSeek, OpenAI, Google Gemini, OpenRouter, or a custom OpenAI-compatible endpoint;
- the optional local companion on `127.0.0.1:8791` for article translation and Obsidian/Notion sync;
- macOS, Node.js, and Apple Command Line Tools (`swiftc`) for desktop captions.

Provider usage can cost money, so I set spending limits in the provider account. A new or uncached translation can still take a moment; Atlas pre-translates and caches ahead to keep playback smooth.

<details>
<summary>Local commands</summary>

```bash
npm run build              # build the article reader
npm test                   # run product and unit tests
npm run typecheck          # check TypeScript
npm run check              # build, typecheck, test, and audit the release set
npm run package            # create dist/readnote-atlas-v0.3.4.zip
npm run companion          # start article translation and knowledge sync
npm run desktop:captions   # start the optional macOS caption helper
```

To start the companion, run `npm run companion` and open `http://127.0.0.1:8791/setup`. Configure only the destinations and providers I want to use. Secrets stay in the ignored `.env.local` file.

</details>

<details>
<summary>Questions I may have</summary>

**Why is a video not translated?** It needs native YouTube captions, a Supadata key, and a configured video AI provider. Shorts, live streams, private videos, and videos without native captions are outside this release.

**Where is my data?** Notes, transcripts, caches, settings, and watched progress stay in Chrome local storage. YouTube caption fetching, pretranslation, and Overview generation can begin when a video loads. Supadata receives the video URL; the selected AI provider receives the transcript text or context needed for the requested action.

**Why does a translation sometimes wait?** Atlas pre-translates ahead, caches results, and prioritizes the active cue after a seek. A new video, an uncached position, provider rate limits, or network delay can still add a wait.

**How do I update?** In my local repository, I run `git pull --ff-only`, `npm install`, and `npm run build`, reload Atlas at `chrome://extensions`, refresh open pages, and restart the desktop helper if its code changed.

</details>

## Why I built Atlas

I started with Readnote because understanding a passage matters more when I can keep my own thought beside its source. Interviews, lectures, and long conversations deserve the same treatment. Atlas brings text and video into one loop:

`Source → bilingual understanding → precise selection → personal note → Obsidian / Notion`

The source remains primary. English stays available for nuance, Chinese lowers the language barrier, and every note remains close enough to revisit. The interface follows the Readnote visual language: quiet, direct, and designed to help me keep learning rather than collect translations.

## Origins and attribution

Readnote Atlas is an independent project built from two foundations:

- [Readnote](https://github.com/pheobepotato/readnote), created by the same author, established the source-first reading philosophy, local annotation model, and Obsidian/Notion workflow.
- [YouTube Digest v1.2.0](https://github.com/zarazhangrui/youtube-digest/releases/tag/v1.2.0), created by **Zara Zhang**, provided the open-source foundation and inspiration for transcript retrieval, bilingual video study, timestamp navigation, explanations, and video notes. Portions of Atlas's video workflow code are derived from and substantially redesigned from that project under the MIT License.

Readnote Atlas is not an official YouTube Digest release and is not endorsed by Zara Zhang. Original notices remain in [LICENSE](LICENSE); project history is documented in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).

## Privacy and license

Read the complete data-flow description in [PRIVACY.md](PRIVACY.md). Readnote Atlas is released under the [MIT License](LICENSE).
