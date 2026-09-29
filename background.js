/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling the configured AI provider to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js", "transcript.js", "knowledge.js", "library.js");
importScripts("desktop-captions-background.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};
const isYouTubeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["youtube.com", "www.youtube.com"].includes(url.hostname);
  } catch (_) { return false; }
};
const YOUTUBE_URL_PATTERNS = ["https://youtube.com/*", "https://www.youtube.com/*"];

/**
 * Observe an optional Promise returned by a Chrome API without assuming every
 * supported browser (or test double) implements the Promise overload.
 */
function quietlyRunChromeApi(operation, label) {
  try {
    const result = operation();
    if (result && typeof result.catch === "function") {
      void result.catch((error) => debugLog(label, error));
    }
  } catch (error) {
    debugLog(label, error);
  }
}

const OVERLAY_SEGMENT_LIMITS = Object.freeze({
  minChars: 28,
  idealChars: 72,
  maxChars: 120,
  maxSeconds: 8,
});
const COMPANION_URL = "http://127.0.0.1:8791";
const overlayTranscriptRequests = new Map();
const overlayTranslationCacheWrites = new Map();
const overviewAnalysisRequests = new Map();
let libraryWriteQueue = Promise.resolve();

function isMissingContentReceiver(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(
    String(error?.message || error || ""),
  );
}

async function sendMessageToYouTubeContent(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["transcript.js", "library.js", "content.js", "desktop-captions-content.js"],
    });
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (retryError) {
      // A navigation can replace the page between reinjection and retry. This
      // is an expected transient state, not an extension error worth retaining
      // on chrome://extensions.
      if (isMissingContentReceiver(retryError)) {
        throw new Error("YouTube page is still loading. Please try again.");
      }
      throw retryError;
    }
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  stream = false,
  onPartial,
  idleTimeoutMs = AI_PROVIDER_IDLE_TIMEOUT_MS,
  hardTimeoutMs = AI_PROVIDER_HARD_TIMEOUT_MS,
}) {
  const settings = await getSettings();
  const providerName = YTD_SETTINGS.providerLabel(settings.provider);
  if (!settings.aiApiKey) {
    const error = new Error(
      `${providerName} API key not configured. Open Readnote Atlas Settings.`,
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  if (stream) body.stream = true;
  // DeepSeek accepts an explicit switch that prevents reasoning traces. Other
  // OpenAI-compatible vendors must not receive provider-specific fields.
  if (YTD_SETTINGS.PROVIDERS[settings.provider]?.disableThinking) {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      idleTimeoutMs,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    hardTimeoutMs,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the provider is still making progress.
    resetIdleTimeout();

    const data = stream && response.ok
      ? await readBoundedStreamingAiResponse(response, resetIdleTimeout, onPartial)
      : await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `${providerName} error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error(`${providerName} returned an empty response.`);
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        `${providerName} request was inactive for ${Math.round(idleTimeoutMs / 1000)} seconds. Please Retry.`,
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        `${providerName} request exceeded the ${Math.round(hardTimeoutMs / 1000)}-second limit. Please Retry.`,
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedStreamingAiResponse(response, onActivity, onPartial) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const data = await response.json();
    onActivity();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text === "string" && text) onPartial?.(text);
    return data;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseBytes = 0;
  const consumeEvent = (eventText) => {
    const payload = eventText
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload);
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onPartial?.(text);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    responseBytes += value?.byteLength ?? 0;
    if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel?.().catch(() => {});
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      consumeEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  return { choices: [{ message: { content: text } }] };
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including blank keepalive chunks.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!isYouTubeUrl(tab.url)) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    if (tab.id) {
      chrome.tabs
        .sendMessage(tab.id, { type: "rk:translate-page" })
        .catch(() => {});
    }
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  quietlyRunChromeApi(
    () =>
      chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: "sidepanel.html",
        enabled: true,
      }),
    "[Readnote Atlas BG] Side panel setup unavailable:",
  );
  quietlyRunChromeApi(
    () => chrome.sidePanel.open({ tabId: tab.id }),
    "[Readnote Atlas BG] Side panel open unavailable:",
  );
});

/**
 * The side panel belongs to video pages. On articles the action triggers
 * in-page translation instead.
 */
quietlyRunChromeApi(
  () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
  "[Readnote Atlas BG] Side panel behavior unavailable:",
);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make Readnote Atlas behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by Readnote Atlas.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  const isYouTube = isYouTubeUrl(url);
  if (!isYouTube) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    const analysisRequest = message.videoId
      ? chrome.storage.local.get(`digest_${message.videoId}`).then((stored) =>
          ensureOverviewForVideo(
            message.videoId,
            sender.tab?.id,
            stored[`digest_${message.videoId}`] || {
              transcriptTimestamped: message.transcriptText,
            },
            {
              title: message.videoTitle,
              channelName: message.channelName,
              description: message.videoDescription,
              duration: message.videoDuration,
            },
          ).then((analysis) =>
            analysis
              ? { success: true, analysis }
              : { success: false, error: "Overview generation failed." },
          ),
        )
      : handleAnalyzeTranscript(
          message.transcriptText,
          message.videoTitle,
          message.channelName,
          message.videoDescription,
          message.videoDuration,
        );
    analysisRequest
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save exact selected transcript
    // text when the side panel supplies it.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
      message.personalNote,
      message.noteOnly,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "recordWatchProgress") {
    handleRecordWatchProgress(message.video, message.watchedSeconds)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "syncNote") {
    handleSyncNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "syncArticleExcerpt") {
    handleSyncArticleExcerpt(message.excerpt)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "translateArticle") {
    handleTranslateArticle(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getOverlayState") {
    handleGetOverlayState(message.videoId, sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "setOverlayMode") {
    handleSetOverlayMode(message.videoId, message.mode)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "translateOverlayBatch") {
    let lastPartialLength = 0;
    const segmentId = Array.isArray(message.segmentIds) && message.segmentIds.length === 1
      ? message.segmentIds[0]
      : "";
    const onPartial = sender.tab?.id && segmentId
      ? (translation) => {
          if (
            translation.length - lastPartialLength < 2 &&
            !/[，。！？；：,.!?;:]$/.test(translation)
          ) return;
          lastPartialLength = translation.length;
          Promise.resolve(chrome.tabs.sendMessage?.(sender.tab.id, {
            action: "subtitleTranslationPartial",
            videoId: message.videoId,
            segmentId,
            generation: message.generation,
            translation,
          })).catch(() => {});
        }
      : undefined;
    handleTranslateOverlayBatch(message.videoId, message.segmentIds, { onPartial })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[Readnote Atlas BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          debugLog("[Readnote Atlas BG] openSidePanel unavailable:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              debugLog(
                "[Readnote Atlas BG] openSidePanel fallback unavailable:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[Readnote Atlas BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[Readnote Atlas BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          const groups = await Promise.all(YOUTUBE_URL_PATTERNS.map(url => chrome.tabs.query({ url, active: true })));
          tabs = groups.flat();
          debugLog("[Readnote Atlas BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          const groups = await Promise.all(YOUTUBE_URL_PATTERNS.map(url => chrome.tabs.query({ url })));
          tabs = groups.flat();
          debugLog("[Readnote Atlas BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[Readnote Atlas BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await sendMessageToYouTubeContent(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[Readnote Atlas BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[Readnote Atlas BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        debugLog("[Readnote Atlas BG] Relay unavailable:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[Readnote Atlas BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

function normalizeTranscriptPayload(data) {
  const transcript = [];
  const plainLines = [];
  const timestampedLines = [];
  for (const chunk of Array.isArray(data?.content) ? data.content : []) {
    const cleanText = String(chunk?.text || "").replace(/>> ?/g, "").trim();
    if (!cleanText) continue;
    const startSeconds = Math.max(0, (Number(chunk.offset) || 0) / 1000);
    const displaySeconds = Math.floor(startSeconds);
    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    transcript.push({
      text: cleanText,
      start: startSeconds,
      duration: Math.max(0, (Number(chunk.duration) || 0) / 1000),
      language: chunk.lang || data.lang || null,
    });
    plainLines.push(cleanText);
    timestampedLines.push(`[${minutes}:${String(seconds).padStart(2, "0")}] ${cleanText}`);
  }
  return {
    transcript,
    transcriptText: plainLines.join(" "),
    transcriptTextTimestamped: timestampedLines.join("\n"),
    language: typeof data?.lang === "string" ? data.lang : null,
  };
}

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open Readnote Atlas Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open Readnote Atlas Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

    const normalized = normalizeTranscriptPayload(data);

    if (normalized.transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return { success: true, ...normalized };
  } catch (error) {
    debugLog("Transcript fetch unavailable:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      const normalized = normalizeTranscriptPayload(data);
      if (!normalized.transcript.length) {
        throw new Error("Supadata returned an empty transcript.");
      }
      return { success: true, ...normalized };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks for one comprehensive Chinese account of the full discussion.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  let providerName = "AI provider";
  try {
    const settings = await getSettings();
    providerName = YTD_SETTINGS.providerLabel(settings.provider);
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `${providerName} API key not configured. Open Readnote Atlas Settings.`,
      };
    }

    const promptVariables = {
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[Readnote Atlas] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 6000,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    analysis = validateOverview(analysis);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    debugLog("Analysis unavailable:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: `${providerName} rejected the API key.`,
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: `${providerName} rate-limited this request. Try again shortly.`,
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Rebuilds the one-field Overview schema from untrusted model output.
 */
function validateOverview(analysis) {
  return {
    overviewZh:
      typeof analysis?.overviewZh === "string"
        ? analysis.overviewZh.trim().slice(0, 30_000)
        : "",
  };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await sendMessageToYouTubeContent(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

async function handleGetOverlayState(videoId, tabId) {
  YTD_SETTINGS.canonicalYouTubeUrl(videoId);
  const cacheKey = `digest_${videoId}`;
  const stored = await chrome.storage.local.get([
    cacheKey,
    ReadnoteTranscript.DISPLAY_MODE_STORAGE_KEY,
  ]);
  let cached = stored[cacheKey];
  const configuredMode =
    stored[ReadnoteTranscript.DISPLAY_MODE_STORAGE_KEY]?.[videoId]?.mode;
  const mode = ReadnoteTranscript.isDisplayMode(configuredMode)
    ? configuredMode
    : ReadnoteTranscript.DEFAULT_DISPLAY_MODE;
  if (!cached?.transcript?.length) {
    let request = overlayTranscriptRequests.get(videoId);
    if (!request) {
      request = handleFetchTranscript(videoId).finally(() => {
        overlayTranscriptRequests.delete(videoId);
      });
      overlayTranscriptRequests.set(videoId, request);
    }
    const transcriptResult = await request;
    if (!transcriptResult?.success) {
      return {
        success: false,
        pending: false,
        mode,
        error: transcriptResult?.error || "Transcript unavailable.",
      };
    }
    cached = {
      transcript: transcriptResult.transcript,
      transcriptText: transcriptResult.transcriptText,
      transcriptTimestamped: transcriptResult.transcriptTextTimestamped,
      transcriptLanguage: transcriptResult.language || null,
      paragraphCache: {},
      timestamp: Date.now(),
    };
    await chrome.storage.local.set({ [cacheKey]: cached });
  }

  // The player requests its subtitle state as soon as a video loads. Start the
  // Overview in the background at that same point so opening Atlas later does
  // not introduce a second wait. This never blocks live subtitle rendering.
  void ensureOverviewForVideo(videoId, tabId, cached);

  const translations = cached.paragraphCache || {};
  const segments = ReadnoteTranscript.groupEntries(
    cached.transcript,
    OVERLAY_SEGMENT_LIMITS,
  ).map(
    (segment) => ({
      ...segment,
      translation:
        translations[ReadnoteTranscript.translationKey(videoId, segment)] || "",
    }),
  );
  return {
    success: true,
    mode,
    title: cached.videoTitle || "",
    segments,
  };
}

function ensureOverviewForVideo(videoId, tabId, cachedDigest, metadata = {}) {
  if (cachedDigest?.analysis?.overviewZh) return Promise.resolve(cachedDigest.analysis);
  const existing = overviewAnalysisRequests.get(videoId);
  if (existing) return existing;

  const request = (async () => {
    const transcriptTimestamped =
      cachedDigest?.transcriptTimestamped ||
      cachedDigest?.transcriptTextTimestamped ||
      cachedDigest?.transcriptText ||
      "";
    if (!transcriptTimestamped) return null;
    const details = Number.isInteger(tabId)
      ? await getPlayerVideoDetails(tabId)
      : null;
    const result = await handleAnalyzeTranscript(
      transcriptTimestamped,
      metadata.title || details?.title || cachedDigest?.videoTitle || "",
      metadata.channelName || details?.channelName || cachedDigest?.channelName || "",
      metadata.description || details?.description || "",
      metadata.duration || details?.duration || 0,
    );
    if (!result?.success) return null;

    // Merge against the latest cache so concurrent subtitle translations are
    // never erased by the slower Overview request.
    const cacheKey = `digest_${videoId}`;
    const stored = await chrome.storage.local.get(cacheKey);
    const latest = stored[cacheKey] || cachedDigest;
    await chrome.storage.local.set({
      [cacheKey]: {
        ...latest,
        analysis: result.analysis,
        videoTitle: metadata.title || details?.title || latest?.videoTitle || "",
        channelName:
          metadata.channelName || details?.channelName || latest?.channelName || "",
        timestamp: Date.now(),
      },
    });
    return result.analysis;
  })().finally(() => {
    overviewAnalysisRequests.delete(videoId);
  });
  overviewAnalysisRequests.set(videoId, request);
  return request;
}

async function handleSetOverlayMode(videoId, mode) {
  YTD_SETTINGS.canonicalYouTubeUrl(videoId);
  if (!ReadnoteTranscript.isDisplayMode(mode)) {
    return { success: false, error: "Unsupported subtitle mode." };
  }
  await ReadnoteTranscript.saveDisplayMode(chrome.storage.local, videoId, mode);
  return { success: true, mode };
}

/**
 * Serialises per-video cache merges. Translation batches run concurrently, so
 * writing the stale object each request originally read can erase a sibling
 * batch that completed milliseconds earlier.
 */
async function mergeOverlayTranslationsIntoCache(videoId, translationsByKey) {
  const cacheKey = `digest_${videoId}`;
  const previous = overlayTranslationCacheWrites.get(videoId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(cacheKey);
    const latest = stored[cacheKey];
    if (!latest?.transcript?.length) return false;
    latest.paragraphCache = {
      ...(latest.paragraphCache || {}),
      ...translationsByKey,
    };
    await chrome.storage.local.set({ [cacheKey]: latest });
    return true;
  });
  overlayTranslationCacheWrites.set(videoId, queued);
  try {
    return await queued;
  } finally {
    if (overlayTranslationCacheWrites.get(videoId) === queued) {
      overlayTranslationCacheWrites.delete(videoId);
    }
  }
}

async function handleTranslateOverlayBatch(videoId, segmentIds, { onPartial } = {}) {
  YTD_SETTINGS.canonicalYouTubeUrl(videoId);
  const cacheKey = `digest_${videoId}`;
  const storageKey = ReadnoteTranscript.DISPLAY_MODE_STORAGE_KEY;
  const stored = await chrome.storage.local.get([cacheKey, storageKey]);
  const configuredMode = stored[storageKey]?.[videoId]?.mode;
  if (configuredMode === "off") {
    return { success: true, translations: [] };
  }
  const cached = stored[cacheKey];
  if (!cached?.transcript?.length) {
    return { success: false, error: "Transcript is not ready." };
  }
  const segments = ReadnoteTranscript.groupEntries(
    cached.transcript,
    OVERLAY_SEGMENT_LIMITS,
  );
  const requestedIds = [...new Set(Array.isArray(segmentIds) ? segmentIds : [])]
    .filter((id) => typeof id === "string")
    .slice(0, 8);
  const requested = requestedIds
    .map((id) => segments.find((segment) => segment.id === id))
    .filter(Boolean);
  if (!requested.length) {
    return { success: false, error: "Subtitle segments are no longer available." };
  }
  const cachedTranslations = cached.paragraphCache || {};
  const translations = new Map();
  const missing = [];
  requested.forEach((segment) => {
    const existing = cachedTranslations[ReadnoteTranscript.translationKey(videoId, segment)];
    if (existing) translations.set(segment.id, existing);
    else missing.push(segment);
  });

  if (missing.length) {
    const translationInput = missing.map(({ id, text }) => ({ id, text }));
    const result = missing.length === 1
      ? await handleTranslateLiveSubtitle(
          translationInput[0],
          cached.videoTitle || "",
          onPartial,
        )
      : await handleTranslateContent(
          { segments: translationInput },
          "transcriptBatch",
          "zh",
          cached.videoTitle || "",
        );
    if (!result?.success) {
      return { success: false, error: result?.error || "Translation failed." };
    }
    for (const item of result.translatedContent?.segments || []) {
      if (typeof item?.id === "string" && typeof item?.text === "string" && item.text.trim()) {
        translations.set(item.id, item.text.trim());
      }
    }
  }

  if (!translations.size) {
    return { success: false, error: "Translation returned no subtitle text." };
  }
  const cacheUpdates = {};
  requested.forEach((segment) => {
    const translation = translations.get(segment.id);
    if (translation) {
      cacheUpdates[ReadnoteTranscript.translationKey(videoId, segment)] = translation;
    }
  });
  await mergeOverlayTranslationsIntoCache(videoId, cacheUpdates);
  return {
    success: true,
    translations: requested
      .filter((segment) => translations.has(segment.id))
      .map((segment) => ({ segmentId: segment.id, translation: translations.get(segment.id) })),
  };
}

async function syncNoteToKnowledgeBase(note) {
  if (typeof ReadnoteKnowledge === "undefined") {
    return { status: "unavailable", obsidian: "unknown", notion: "unknown" };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${COMPANION_URL}/sync-excerpt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excerpt: ReadnoteKnowledge.noteToExcerpt(note) }),
      signal: controller.signal,
    });
    if (!response.ok) return ReadnoteKnowledge.syncState(null);
    return ReadnoteKnowledge.syncState(await response.json());
  } catch (_error) {
    return ReadnoteKnowledge.syncState(null);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function companionPost(path, body, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${COMPANION_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { success: response.ok, ...data };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleSyncArticleExcerpt(excerpt) {
  if (!excerpt?.id || !excerpt?.text || !excerpt?.sourceUrl) {
    return { success: false, error: "Invalid excerpt." };
  }
  return companionPost("/sync-excerpt", { excerpt });
}

async function handleTranslateArticle(payload) {
  if (!Array.isArray(payload?.paragraphs) || !payload.paragraphs.length) {
    return { success: false, error: "No article paragraphs supplied." };
  }
  return companionPost("/translate", payload, 120_000);
}

async function replaceStoredNote(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = (result.ytd_notes || []).map((item) =>
    item.id === note.id ? note : item,
  );
  await chrome.storage.local.set({ ytd_notes: notes });
}

async function syncStoredNote(note) {
  const knowledgeSync = await syncNoteToKnowledgeBase(note);
  const syncedNote = { ...note, knowledgeSync };
  await replaceStoredNote(syncedNote);
  chrome.runtime.sendMessage({ action: "noteSaved", note: syncedNote }).catch(() => {});
  return syncedNote;
}

async function handleSyncNote(noteId) {
  const result = await chrome.storage.local.get("ytd_notes");
  const note = (result.ytd_notes || []).find((item) => item.id === noteId);
  if (!note) return { success: false, error: "Note not found." };
  const syncedNote = await syncStoredNote(note);
  return { success: true, note: syncedNote };
}

/**
 * Saves a note at a timestamp. Exact selected text is stored directly.
 * Other note requests find the relevant transcript line and clean it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
  personalNote,
  noteOnly = false,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";
    const safePersonalNote =
      typeof personalNote === "string"
        ? personalNote.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // Free-form thoughts are first-class notes even when the user has not
    // selected a source passage. Keeping source text empty lets the Notes UI
    // distinguish the user's own thought from a quoted transcript paragraph.
    if (noteOnly && safePersonalNote) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        kind: "thought",
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: "",
        rawText: "",
        personalNote: safePersonalNote,
        knowledgeSync: {
          status: "syncing",
          obsidian: "unknown",
          notion: "unknown",
        },
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      void syncStoredNote(note).catch((error) =>
        console.warn("[Readnote Atlas] Knowledge sync failed:", error),
      );
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without a transcript fetch or an AI cleanup request.
    if (exactSelectedText) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        kind: "excerpt",
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: exactSelectedText,
        rawText: exactSelectedText,
        personalNote: safePersonalNote,
        knowledgeSync: { status: "syncing", obsidian: "unknown", notion: "unknown" },
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      void syncStoredNote(note).catch((error) =>
        console.warn("[Readnote Atlas] Knowledge sync failed:", error),
      );
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[Readnote Atlas] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[Readnote Atlas] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      kind: "bookmark",
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      personalNote: safePersonalNote,
      knowledgeSync: { status: "syncing", obsidian: "unknown", notion: "unknown" },
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);
    void syncStoredNote(note).catch((error) =>
      console.warn("[Readnote Atlas] Knowledge sync failed:", error),
    );

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    debugLog("[Readnote Atlas] Save note unavailable:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Serializes watch-time writes from every YouTube tab. Content scripts send
 * small wall-clock deltas only while a visible video is actually playing, so
 * seeks and playback-position jumps never inflate the personal library.
 */
async function handleRecordWatchProgress(video, watchedSeconds) {
  const queued = libraryWriteQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(ReadnoteLibrary.STORAGE_KEY);
    const next = ReadnoteLibrary.recordWatchSample(
      stored[ReadnoteLibrary.STORAGE_KEY],
      video,
      watchedSeconds,
    );
    await chrome.storage.local.set({ [ReadnoteLibrary.STORAGE_KEY]: next });
    const item = next.items.find((entry) => entry.videoId === video?.videoId);
    return {
      success: true,
      qualified:
        Boolean(item) &&
        item.watchedSeconds >= ReadnoteLibrary.WATCHED_THRESHOLD_SECONDS,
      watchedSeconds: item?.watchedSeconds || 0,
    };
  });
  libraryWriteQueue = queued;
  return queued;
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[Readnote Atlas] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[Readnote Atlas] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    debugLog("[Readnote Atlas] Cleanup unavailable:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    const providerName = YTD_SETTINGS.providerLabel(settings.provider);
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `${providerName} API key not configured.`,
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[Readnote Atlas] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    debugLog("Explain selection unavailable:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 6) {
    throw new Error("Transcript translation requires 1 to 6 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

async function handleTranslateLiveSubtitle(segment, videoTitle, onPartial) {
  try {
    const [source] = validateTranscriptBatchRequest({ segments: [segment] });
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules("zh");
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Live subtitle translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const result = await callAiTranslation(systemPrompt, source.text, {
      temperature: 0.1,
      maxTokens: 160,
      stream: true,
      onPartial,
      idleTimeoutMs: 8_000,
      hardTimeoutMs: 15_000,
    });
    if (!result.success) return result;

    const translation = String(result.text || "")
      .trim()
      .replace(/^```(?:text)?\s*/i, "")
      .replace(/\s*```$/, "")
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();
    if (!translation || !looksLikeChineseTranslation(translation, source.text)) {
      return { success: false, error: "Translation returned no valid Chinese subtitle" };
    }
    return {
      success: true,
      translatedContent: {
        segments: [{ id: source.id, text: translation, error: "" }],
      },
    };
  } catch (error) {
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Translates content using the configured AI provider.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    const providerName = YTD_SETTINGS.providerLabel(settings.provider);
    if (!settings.aiApiKey) {
      return { success: false, error: `${providerName} API key not configured` };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    debugLog("[Readnote Atlas] Translation unavailable:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single configured-provider call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  {
    temperature = 0.3,
    maxTokens = 8192,
    responseFormat,
    stream,
    onPartial,
    idleTimeoutMs,
    hardTimeoutMs,
  } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      stream,
      onPartial,
      idleTimeoutMs,
      hardTimeoutMs,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  normalizeTranscriptPayload,
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateLiveSubtitle,
  handleTranslateArticle,
  mergeOverlayTranslationsIntoCache,
  ensureOverviewForVideo,
  handleSaveNote,
  handleRecordWatchProgress,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
  sendMessageToYouTubeContent,
};
