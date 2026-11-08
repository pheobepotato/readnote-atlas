const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("video translation exposes only bilingual On and Off", () => {
  const panel = read("sidepanel.html");
  const panelScript = read("sidepanel.js");
  const content = read("content.js");
  assert.match(panel, /data-transcript-mode="bilingual"[\s\S]*?>On</);
  assert.match(panel, /data-transcript-mode="off"[\s\S]*?>Off</);
  assert.doesNotMatch(panel, /data-transcript-mode="(?:original|zh)"/);
  assert.match(
    panelScript,
    /let currentTranscriptMode = ReadnoteTranscript\.DEFAULT_DISPLAY_MODE/,
  );
  assert.match(panelScript, /ReadnoteTranscript\.DISPLAY_MODE_STORAGE_KEY/);
  assert.match(content, /ReadnoteTranscript\.DISPLAY_MODE_STORAGE_KEY/);
  assert.match(content, /data-mode="bilingual">On</);
  assert.match(content, /data-mode="off">Off</);
  assert.doesNotMatch(content, />EN<|>关闭<|>中英</);
});

test("Overview is one comprehensive Chinese discussion summary", () => {
  const panel = read("sidepanel.html");
  const panelScript = read("sidepanel.js");
  const prompt = read("prompts/analysis.md");
  const background = read("background.js");
  assert.match(panel, /id="overviewContent"/);
  assert.doesNotMatch(panel, />Chapters<|>Key Quotes</);
  assert.match(prompt, /overviewZh/);
  assert.doesNotMatch(prompt, /keyQuotes|key quotes/i);
  assert.match(background, /overviewZh/);
  assert.match(panelScript, /normalizeCachedAnalysis\(cached\.analysis\)/);
  assert.match(panelScript, /function normalizeCachedAnalysis/);
  assert.match(panelScript, /let analysisGeneration = 0/);
  assert.match(panelScript, /requestGeneration !== analysisGeneration/);
  assert.match(panelScript, /requestVideoId !== currentVideoId/);
  assert.match(background, /function ensureOverviewForVideo/);
  assert.match(background, /void ensureOverviewForVideo\(videoId, tabId, cached\)/);
  assert.match(background, /\.\.\.latest,[\s\S]*analysis: result\.analysis/);
  assert.match(panel, />Chinese Overview</);
});

test("Library has one tab entry and no duplicate header action", () => {
  const panel = read("sidepanel.html");
  const panelScript = read("sidepanel.js");
  const css = read("sidepanel.css");
  assert.equal((panel.match(/data-tab="library"/g) || []).length, 1);
  assert.doesNotMatch(panel, /id="libraryBtn"/);
  assert.match(panelScript, /function openLibraryView/);
  assert.match(panelScript, /tabs\?\.classList\.toggle\("library-only", !currentTranscript\)/);
  assert.match(css, /\.tabs\.library-only/);
});

test("player subtitles prefetch a batch and expose clear, minimal controls", () => {
  const content = read("content.js");
  const background = read("background.js");
  assert.match(content, /action: "translateOverlayBatch"/);
  assert.match(content, /SUBTITLE_PREFETCH_BATCH_SIZE = 6/);
  assert.match(content, /SUBTITLE_PREFETCH_WINDOW = 96/);
  assert.match(content, /SUBTITLE_PREFETCH_SECONDS = 180/);
  assert.match(content, /MAX_SUBTITLE_PREFETCH_REQUESTS = 3/);
  assert.match(content, /scheduleReadnoteSubtitlePrefetch/);
  assert.match(content, /requestReadnoteActiveTranslation/);
  assert.match(content, /message\.action === "subtitleTranslationPartial"/);
  assert.match(content, /message\.generation !== readnoteSubtitleTranslationGeneration/);
  assert.match(background, /handleTranslateOverlayBatch/);
  assert.match(content, /data-style-action="smaller"/);
  assert.match(content, />Size</);
  assert.doesNotMatch(content, /data-style-action="font"/);
  assert.doesNotMatch(content, /data-style-action="(?:higher|lower)"/);
  assert.match(content, /readnote_subtitle_style/);
  assert.match(content, /data-controls-toggle/);
  assert.match(content, /rn-subtitle-settings/);
  assert.match(content, /ReadnoteTranscript\.wrapSubtitle/);
  assert.match(content, /if \(readnoteSubtitleMode !== "bilingual"/);
  assert.match(content, /pointerdown/);
  assert.match(content, /pointermove/);
  assert.match(content, /--rn-subtitle-x/);
  assert.match(content, /--rn-subtitle-width/);
  assert.match(content, /data-resize-handle/);
  assert.match(content, /setupReadnoteBackgroundCaptionSync/);
  assert.doesNotMatch(content, /data-background-captions/);
  assert.match(content, /document\.visibilityState === "hidden"/);
  assert.match(content, /video\.paused/);
  assert.match(content, /video\.ended/);
  assert.match(content, /requestWindow\(size\)/);
  assert.match(content, /rn-background-caption-en/);
  assert.match(content, /rn-background-caption-zh/);
  assert.match(content, /fitReadnoteBackgroundCaptionText/);
  assert.match(content, /ResizeObserver/);
  assert.match(content, /setActionHandler\("enterpictureinpicture"/);
  assert.doesNotMatch(content, /setActionHandler\("leavepictureinpicture"/);
  assert.doesNotMatch(content, />Enable<|>Enabled</);
  assert.match(content, /data-caption-save[\s\S]*?M6 4\.8A1\.8 1\.8/);
  const backgroundMarkup = content.match(/captionWindow\.document\.body\.innerHTML = `[^`]*`;/)?.[0] || "";
  assert.doesNotMatch(backgroundMarkup, /youtube\.com/);
  assert.doesNotMatch(content, /data-background-layout/);
  assert.match(content, /readnoteSubtitleTranslationGeneration/);
  assert.match(content, /ReadnoteTranscript\.planTranslationWindow/);
  assert.match(content, /readnote_subtitle_style_v6/);
  assert.match(content, /width:\s*"auto"/);
  assert.match(content, /width:var\(--rn-subtitle-width,max-content\)/);
  assert.match(content, /\.rn-subtitle-copy \{[^}]*background:rgba\(7,7,8,/);
  assert.match(content, /\.rn-subtitle-copy \{[^}]*align-items:center/);
  assert.match(content, /\.rn-subtitle-line \{[^}]*background:transparent[^}]*text-align:center/);
  assert.match(content, /#readnote-subtitle-root \{[^}]*z-index:9998/);
  assert.match(content, /\.rn-subtitle-resize \{[^}]*width:24px/);
  assert.match(content, /startLeftPercent/);
  assert.match(content, /pointerPercent - interaction\.startLeftPercent/);
  assert.match(content, /readnoteSubtitleUrgentRequests\.has\(segment\.id\)/);
  assert.match(content, /\.rn-subtitle-zh \{[^}]*#fff7dc/);
  assert.match(content, /background:rgba\(7,7,8,\.64\)/);
  assert.match(content, /if \(!result\?\.success\) throw new Error/);
  assert.match(background, /idleTimeoutMs:\s*8_000/);
  assert.match(background, /hardTimeoutMs:\s*15_000/);
  assert.match(background, /stream:\s*true/);
  assert.doesNotMatch(content, /border:1px dashed/);
});

test("all visible tool chrome is English while generated Chinese remains dynamic", () => {
  const uiSources = [
    read("content.js"),
    read("sidepanel.html"),
    read("sidepanel.js"),
    read("options.html"),
    read("options.js"),
    read("src/article-reader/index.ts"),
  ].join("\n");
  assert.doesNotMatch(uiSources, /[\p{Script=Han}]/u);
  assert.match(read("prompts/analysis.md"), /overviewZh/);
});

test("handled relay failures do not create Chrome extension error entries", () => {
  const background = read("background.js");
  const relayCatch = background.match(
    /if \(message\.action === "relayToContent"\)[\s\S]*?return true; \/\/ Keep channel open/,
  )?.[0] || "";
  assert.doesNotMatch(relayCatch, /console\.error/);
  assert.match(
    background,
    /if \(isMissingContentReceiver\(retryError\)\)[\s\S]*throw new Error\("YouTube page is still loading\. Please try again\."\)/,
  );
  assert.match(background, /function quietlyRunChromeApi\(/);
  assert.match(background, /quietlyRunChromeApi\([\s\S]*?\.setPanelBehavior\(/);
  assert.match(background, /quietlyRunChromeApi\([\s\S]*?\.setOptions\(/);
  assert.match(background, /quietlyRunChromeApi\([\s\S]*?\.open\(/);
});

test("article page actions collapse behind one quiet launcher", () => {
  const article = read("src/article-reader/index.ts");
  const css = read("article-reader.css");
  assert.match(article, /rk-page-actions-toggle/);
  assert.match(article, /aria-expanded/);
  assert.match(article, /rk-page-actions-menu/);
  assert.match(article, /function closePageActionsMenu/);
  assert.match(css, /\.rk-page-actions:not\(\.is-open\) \.rk-page-actions-menu/);
  assert.match(css, /\.rk-page-actions-toggle[\s\S]*?opacity: 0\.45;/);
});
