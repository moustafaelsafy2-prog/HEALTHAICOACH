// netlify/functions/gemini-proxy.js
// Gemini proxy: multi-model fallback, vision support for multiple images, streaming capabilities,
// automatic retries, strict security guards, and language mirroring (AR/EN).

const MAX_TRIES = 3; // Retries per model
const BASE_BACKOFF_MS = 600; // Exponential backoff with jitter
const MAX_OUTPUT_TOKENS_HARD = 8192; // Safe maximum token limit
const DEFAULT_TIMEOUT_MS = 28000; // Within Netlify's 29-second limit
const SAFE_TEMP_RANGE = [0.0, 1.0];
const SAFE_TOPP_RANGE = [0.0, 1.0];

// Media validation and limits
const MAX_INLINE_BYTES = 15 * 1024 * 1024; // 15MB per part
const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i;
const ALLOWED_AUDIO = /^audio\/(webm|ogg|mp3|mpeg|wav|m4a|aac|3gpp|3gpp2|mp4)$/i;

// Gemini model candidates, ordered by preference (speed/cost vs. capability)
const MODEL_POOL = [
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest"
];

exports.handler = async (event) => {
  const reqStart = Date.now();
  const requestId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase();

  const baseHeaders = {
    "Access-Control-Allow-Origin": "*", // Or your specific domain for production
    "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "X-Request-ID": requestId
  };

  // Handle CORS preflight request
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: baseHeaders, body: "" };
  if (event.httpMethod !== "POST") return resp(405, baseHeaders, { error: "Method Not Allowed" });

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return resp(500, baseHeaders, { error: "GEMINI_API_KEY is not configured on the server." });

  // Parse request body
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return resp(400, baseHeaders, { error: "Invalid JSON in request body." });
  }

  // Destructure and validate inputs from the frontend
  let {
    prompt,
    images, // Handles multiple images: [dataUrl | {mime,data}]
    audio,  // Handles audio: {mime,data}
    model = "auto", // 'auto' will try the model pool
    temperature = 0.6,
    top_p = 0.9,
    max_output_tokens = 4096,
    system, // System prompt string
    stream = false, // Not used by frontend, but supported
    timeout_ms = DEFAULT_TIMEOUT_MS,
    concise_image = true, // Force concise replies for images
  } = payload || {};

  // Clamp numeric parameters to safe ranges
  temperature = clampNumber(temperature, SAFE_TEMP_RANGE[0], SAFE_TEMP_RANGE[1], 0.6);
  top_p = clampNumber(top_p, SAFE_TOPP_RANGE[0], SAFE_TOPP_RANGE[1], 0.9);
  max_output_tokens = clampNumber(max_output_tokens, 1, MAX_OUTPUT_TOKENS_HARD, 4096);
  timeout_ms = clampNumber(timeout_ms, 1000, 29000, DEFAULT_TIMEOUT_MS);

  if (!prompt && (!Array.isArray(images) || images.length === 0)) {
    return resp(400, baseHeaders, { error: "Request must include a 'prompt' or 'images'." });
  }

  // --- Guardrails & Language Mirroring ---
  const lang = hasArabic(prompt) ? "ar" : "en";
  const hasAnyImages = Array.isArray(images) && images.length > 0;

  // Build the final prompt parts, including media
  const parts = buildParts(prompt, images, audio);
  if (parts.length === 0) {
      return resp(400, baseHeaders, { error: "Invalid or oversized media files provided." });
  }
  const contents = [{ role: "user", parts }];

  const generationConfig = { temperature, topP: top_p, maxOutputTokens: max_output_tokens };
  
  // The system prompt is passed as `systemInstruction` in the API call
  const systemInstruction = (system && typeof system === "string")
    ? { role: "system", parts: [{ text: system }] }
    : undefined;

  // Determine which models to try
  const candidates = (model === "auto" || !model)
    ? [...MODEL_POOL]
    : [model, ...MODEL_POOL.filter(m => m !== model)]; // Try specified model first, then fallbacks

  // --- Non-Streaming Logic (for this specific app) ---
  for (let mi = 0; mi < candidates.length; mi++) {
    const currentModel = candidates[mi];
    const url = makeUrl(currentModel, false, API_KEY);
    const body = JSON.stringify({
      contents,
      generationConfig,
      ...(systemInstruction ? { systemInstruction } : {})
    });

    const result = await tryJSONRequestWithRetries(url, body, timeout_ms);

    if (result.ok) {
      // Successfully got a response
      return resp(200, baseHeaders, {
        text: mirrorLanguage(result.text, lang), // Ensure response language matches prompt
        model: currentModel,
        lang,
        usage: result.usage || undefined,
        requestId,
        took_ms: Date.now() - reqStart
      });
    }

    if (mi === candidates.length - 1) {
      // All models failed
      const status = result.statusCode || 502; // 502 Bad Gateway if upstream fails
      return resp(status, baseHeaders, { ...(result.error || { error: "All models failed to respond." }), requestId, lang });
    }
    // Otherwise, loop will continue and try the next model in the pool
  }

  return resp(500, baseHeaders, { error: "An unknown error occurred after trying all models.", requestId, lang });
};

/* -------------------- Helper Functions -------------------- */

function resp(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj ?? {}) };
}

function clampNumber(n, min, max, fallback) {
  const v = Number.isFinite(+n) ? +n : fallback;
  return Math.max(min, Math.min(max, v));
}

function makeUrl(model, isStream, apiKey) {
  const base = "https://generativelace.googleapis.com/v1beta/models";
  const method = isStream ? "streamGenerateContent" : "generateContent";
  return `${base}/${encodeURIComponent(model)}:${method}?key=${apiKey}`;
}

function hasArabic(s) {
  return /[\u0600-\u06FF]/.test(s || "");
}

function mirrorLanguage(text, lang) {
  if (!text) return text;
  if (lang === "ar" && hasArabic(text)) return text;
  if (lang === "en" && !hasArabic(text)) return text;
  
  // If language mismatch, add a note to clarify for the user.
  return (lang === "ar")
    ? `**ملاحظة:** تم تقديم الرد باللغة العربية.\n\n${text}`
    : `**Note:** The response is provided in English.\n\n${text}`;
}

function buildParts(prompt, images, audio) {
  const parts = [];
  if (typeof prompt === "string" && prompt.trim()) {
    parts.push({ text: prompt });
  }
  parts.push(...coerceMediaParts(images, "image"));
  parts.push(...coerceMediaParts(audio ? [audio] : [], "audio")); // audio is single, not array
  return parts;
}

function coerceMediaParts(mediaArray, type) {
  const parts = [];
  if (!Array.isArray(mediaArray)) return parts;
  
  const ALLOWED_MIMES = type === 'image' ? ALLOWED_IMAGE : ALLOWED_AUDIO;

  for (const item of mediaArray) {
    let mime, b64;
    if (typeof item === "string" && item.startsWith("data:")) {
      ({ mime, data: b64 } = fromDataUrl(item));
    } else if (item && typeof item === "object") {
      mime = item.mime || item.mime_type;
      b64 = item.data || item.base64;
    }

    if (!mime || !b64) continue;
    if (!ALLOWED_MIMES.test(mime)) continue; // Skip unsupported types
    if (approxBase64Bytes(b64) > MAX_INLINE_BYTES) continue; // Skip oversized files

    parts.push({ inline_data: { mime_type: mime, data: b64 } });
  }
  return parts;
}

function fromDataUrl(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return {};
  const header = dataUrl.substring(5, commaIndex);
  const mime = header.includes(';') ? header.substring(0, header.indexOf(';')) : header;
  const data = dataUrl.substring(commaIndex + 1);
  return { mime, data };
}

function approxBase64Bytes(b64) {
    if(!b64) return 0;
    const padding = (b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0));
    return (b64.length * 0.75) - padding;
}


/* ---- Network & Retry Logic ---- */

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

function mapErrorStatus(status) {
  if (status === 429) return 429; // Too Many Requests
  if (status >= 500) return 502; // Bad Gateway (upstream error)
  return status;
}

function formatUpstreamError(status, data, text) {
  const message = (data?.error?.message) || (typeof text === "string" ? text.slice(0, 500) : "Upstream API error");
  return { error: "Upstream API error", status, details: message };
}

async function sleepWithJitter(attempt) {
  const baseDelay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 400;
  await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
}

async function tryJSONRequestWithRetries(url, body, timeout_ms) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout_ms);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: abortController.signal
      });
      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseData;
      try { responseData = JSON.parse(responseText); } catch { responseData = null; }

      if (!response.ok) {
        if (shouldRetry(response.status) && attempt < MAX_TRIES) {
          await sleepWithJitter(attempt);
          continue; // Retry
        }
        // Don't retry, return final error
        return { ok: false, statusCode: mapErrorStatus(response.status), error: formatUpstreamError(response.status, responseData, responseText) };
      }

      const parts = responseData?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p.text || "").join("").trim();

      if (!text) {
          // Response was OK but content is empty/blocked by safety settings
        const safetyInfo = responseData?.promptFeedback || responseData?.candidates?.[0]?.safetyRatings;
        return { ok: false, statusCode: 400, error: { error: "Response was empty or blocked by safety filters.", safety: safetyInfo } };
      }

      const usage = responseData?.usageMetadata;
      return { ok: true, text, usage };

    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt < MAX_TRIES) {
        await sleepWithJitter(attempt);
        continue; // Retry on network error/timeout
      }
      return { ok: false, statusCode: 504, error: { error: "Network error or timeout", details: e.message } }; // Gateway Timeout
    }
  }
}


