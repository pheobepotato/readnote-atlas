import { fetch as undiciFetch, ProxyAgent } from "undici";
import { currentMacOSProxyUrl } from "./companion-proxy.mjs";

const DEFAULT_MODEL = "gpt-5.4-nano";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";
const TRANSLATION_INSTRUCTIONS =
  "Translate every supplied reading paragraph completely into Chinese. Do not summarize or omit sentences, list items, or repeated text. Return exactly one translation per input paragraph in the same order. Preserve important English terms in parentheses when useful. Return strict JSON only: {\"translations\":[...]}.";
const proxyAgents = new Map();

const providerConfigs = {
  openai: {
    kind: "responses",
    defaultModel: DEFAULT_MODEL,
    apiKeyEnv: ["READNOTE_TRANSLATION_API_KEY", "OPENAI_API_KEY"],
    modelEnv: ["READNOTE_TRANSLATION_MODEL", "READING_NOTEBOOK_OPENAI_MODEL"],
    missingKeyError: "openai_api_key_missing",
    url: "https://api.openai.com/v1/responses"
  },
  deepseek: {
    kind: "chat",
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    apiKeyEnv: ["READNOTE_TRANSLATION_API_KEY", "DEEPSEEK_API_KEY", "READING_NOTEBOOK_API_KEY"],
    modelEnv: ["READNOTE_TRANSLATION_MODEL", "READNOTE_DEEPSEEK_MODEL", "READING_NOTEBOOK_DEEPSEEK_MODEL", "READING_NOTEBOOK_TRANSLATION_MODEL", "READING_NOTEBOOK_MODEL"],
    baseUrlEnv: ["READNOTE_BASE_URL", "DEEPSEEK_BASE_URL", "READING_NOTEBOOK_BASE_URL"],
    defaultBaseUrl: "https://api.deepseek.com",
    missingKeyError: "deepseek_api_key_missing",
    extraBody: {
      response_format: { type: "json_object" },
      thinking: { type: "disabled" }
    }
  },
  minimax: {
    kind: "chat",
    defaultModel: DEFAULT_MINIMAX_MODEL,
    apiKeyEnv: ["READNOTE_TRANSLATION_API_KEY", "MINIMAX_API_KEY", "READING_NOTEBOOK_API_KEY"],
    modelEnv: ["READNOTE_TRANSLATION_MODEL", "READING_NOTEBOOK_MINIMAX_MODEL", "READING_NOTEBOOK_TRANSLATION_MODEL", "READING_NOTEBOOK_MODEL"],
    baseUrlEnv: ["READNOTE_BASE_URL", "MINIMAX_BASE_URL", "READING_NOTEBOOK_BASE_URL"],
    defaultBaseUrl: "https://api.minimax.io/v1",
    missingKeyError: "minimax_api_key_missing",
    extraBody: {
      thinking: { type: "disabled" }
    }
  }
};

function firstEnvValue(names = []) {
  return names.map((name) => process.env[name]).find((value) => typeof value === "string" && value.trim()) ?? "";
}

function normalizeProviderName(value) {
  return String(value ?? "deepseek")
    .trim()
    .toLowerCase();
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function resolveProvider(options = {}) {
  const providerName = normalizeProviderName(
    options.provider ??
      process.env.READNOTE_TRANSLATION_PROVIDER ??
      process.env.READING_NOTEBOOK_TRANSLATION_PROVIDER ??
      process.env.READING_NOTEBOOK_MODEL_PROVIDER
  );
  const provider = providerConfigs[providerName];
  if (!provider) {
    throw new Error(`unsupported_translation_provider_${providerName}`);
  }

  const apiKey = options.apiKey ?? firstEnvValue(provider.apiKeyEnv);
  const configuredModel = options.model ?? firstEnvValue(provider.modelEnv);
  const configuredBaseUrl = options.baseUrl ?? firstEnvValue(provider.baseUrlEnv);
  const model = configuredModel || provider.defaultModel;
  const baseUrl =
    provider.kind === "chat"
      ? stripTrailingSlash(configuredBaseUrl || provider.defaultBaseUrl)
      : "";

  return {
    ...provider,
    name: providerName,
    apiKey,
    model,
    baseUrl
  };
}

function proxyAgentFor(url) {
  if (!url) {
    return undefined;
  }

  if (!proxyAgents.has(url)) {
    proxyAgents.set(url, new ProxyAgent(url));
  }

  return proxyAgents.get(url);
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") {
    return responseJson.output_text;
  }

  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((content) => content.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function extractChatMessageText(responseJson) {
  const content = responseJson.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function cleanJsonText(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function translationValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  for (const key of ["translation", "text", "zh", "chinese", "content"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function parseTranslations(text, paragraphCount) {
  const parsed = JSON.parse(cleanJsonText(text));
  const translations = Array.isArray(parsed.translations) ? parsed.translations.map((value) => {
    const text = translationValue(value).trim();
    return text === "[object Object]" ? "" : text;
  }) : [];
  if (translations.length !== paragraphCount) {
    throw new Error("translation_count_mismatch");
  }
  // Preserve valid positions so the reader can retry only missing entries.
  return translations;
}

function withProxyIfNeeded(fetchImpl, init, options) {
  if (fetchImpl !== fetch) {
    return fetchImpl;
  }

  const dispatcher = proxyAgentFor(options.proxyUrl ?? currentMacOSProxyUrl());
  if (dispatcher) {
    init.dispatcher = dispatcher;
    return undiciFetch;
  }

  return fetchImpl;
}

function requestSource(input, paragraphs) {
  return JSON.stringify({
    source: input.source ?? {},
    paragraphs
  });
}

function openAiResponsesBody(input, paragraphs, model) {
  return {
    model,
    instructions: TRANSLATION_INSTRUCTIONS,
    input: requestSource(input, paragraphs)
  };
}

function chatCompletionsBody(input, paragraphs, provider) {
  return {
    model: provider.model,
    messages: [
      {
        role: "system",
        content: TRANSLATION_INSTRUCTIONS
      },
      {
        role: "user",
        content: requestSource(input, paragraphs)
      }
    ],
    ...(provider.extraBody ?? {})
  };
}

export function translationProviderStatus(options = {}) {
  const provider = resolveProvider(options);
  return {
    provider: provider.name,
    model: provider.model,
    configured: Boolean(provider.apiKey)
  };
}

export async function translateParagraphs(input, options = {}) {
  const provider = resolveProvider(options);
  if (!provider.apiKey) {
    throw new Error(provider.missingKeyError);
  }

  const paragraphs = Array.isArray(input.paragraphs) ? input.paragraphs.map((p) => (typeof p === "string" ? p : p?.text ?? String(p))) : [];
  if (paragraphs.length === 0) {
    return [];
  }

  let fetchImpl = options.fetchImpl ?? fetch;
  const url = provider.kind === "chat" ? `${provider.baseUrl}/chat/completions` : provider.url;
  const init = {
    method: "POST",
    signal: AbortSignal.timeout(110_000),
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(
      provider.kind === "chat"
        ? chatCompletionsBody(input, paragraphs, provider)
        : openAiResponsesBody(input, paragraphs, provider.model)
    )
  };

  fetchImpl = withProxyIfNeeded(fetchImpl, init, options);

  const response = await fetchImpl(url, init);

  if (!response.ok) {
    throw new Error(`${provider.name}_request_failed_${response.status}`);
  }

  const responseJson = await response.json();
  const outputText = provider.kind === "chat" ? extractChatMessageText(responseJson) : extractOutputText(responseJson);
  return parseTranslations(outputText, paragraphs.length);
}
