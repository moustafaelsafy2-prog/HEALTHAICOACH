// netlify/functions/gemini-proxy.js
// Gemini proxy with: multi-model fallback (auto), vision+audio inline support, streaming, retries, and strict guards.

const MAX_TRIES = 3;                     // محاولات لكل نموذج
const BASE_BACKOFF_MS = 600;             // ارتداد أُسّي مع jitter
const MAX_OUTPUT_TOKENS_HARD = 8192;     // حد أقصى آمن للتوكنات
const DEFAULT_TIMEOUT_MS = 26000;        // ضمن حدود Netlify
const SAFE_TEMP_RANGE = [0.0, 1.0];
const SAFE_TOPP_RANGE = [0.0, 1.0];

// حدود الوسائط
const MAX_INLINE_BYTES = 15 * 1024 * 1024; // 15MB/part
const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i;
const ALLOWED_AUDIO = /^audio\/(webm|ogg|mp3|mpeg|wav|m4a|aac|3gpp|3gpp2|mp4)$/i;

// ترتيب نماذج جيميني المرشحة (يمكن تعديلها)
const MODEL_POOL = [
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];

exports.handler = async (event) => {
  const reqStart = Date.now();
  const requestId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase();

  const baseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "X-Request-ID": requestId
  };

  // CORS
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: baseHeaders, body: "" };
  if (event.httpMethod !== "POST") return resp(405, baseHeaders, { error: "Method Not Allowed" });

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return resp(500, baseHeaders, { error: "GEMINI_API_KEY is missing" });

  // Parse
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return resp(400, baseHeaders, { error: "Invalid JSON" }); }

  // Inputs
  let {
    prompt,
    messages,            // [{role:"user"|"model"|"system", content:"...", images?:[], audio?:{}}]
    images,              // top-level images: [dataUrl | {mime,data}]
    audio,               // top-level audio: {mime,data}
    model = "auto",      // "auto" = جرّب مجموعة النماذج
    temperature = 0.6,
    top_p = 0.9,
    max_output_tokens = 2048,
    system,              // string
    stream = false,
    timeout_ms = DEFAULT_TIMEOUT_MS,
    include_raw = false
  } = payload || {};

  // Validate/clamp
  temperature = clampNumber(temperature, SAFE_TEMP_RANGE[0], SAFE_TEMP_RANGE[1], 0.6);
  top_p = clampNumber(top_p, SAFE_TOPP_RANGE[0], SAFE_TOPP_RANGE[1], 0.9);
  max_output_tokens = clampNumber(max_output_tokens, 1, MAX_OUTPUT_TOKENS_HARD, 2048);
  timeout_ms = clampNumber(timeout_ms, 1000, 29000, DEFAULT_TIMEOUT_MS);

  if (!prompt && !Array.isArray(messages)) {
    return resp(400, baseHeaders, { error: "Missing prompt or messages[]" });
  }

  // Build contents + media
  const contents = Array.isArray(messages)
    ? normalizeMessagesWithMedia(messages)
    : [{ role: "user", parts: buildParts(prompt, images, audio) }];

  const generationConfig = { temperature, topP: top_p, maxOutputTokens: max_output_tokens };
  const systemInstruction = (system && typeof system === "string")
    ? { role: "system", parts: [{ text: system }] }
    : undefined;

  // Candidate models order
  const candidates = (model === "auto" || !model)
    ? [...MODEL_POOL]
    : Array.from(new Set([model, ...MODEL_POOL])); // جرّب المطلوب أولًا ثم الباقي

  // ============== STREAMING (SSE) مع سقوط على نماذج أخرى ==============
  if (stream) {
    const headers = {
      ...baseHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    };

    for (let mi = 0; mi < candidates.length; mi++) {
      const m = candidates[mi];
      const url = makeUrl(m, true, API_KEY);
      const body = JSON.stringify({
        contents,
        generationConfig,
        ...(systemInstruction ? { systemInstruction } : {})
      });

      const sseOnce = await tryStreamOnce(url, body, timeout_ms);
      if (sseOnce.ok) {
        const reader = sseOnce.response.body.getReader();
        const encoder = new TextEncoder();
        return {
          statusCode: 200,
          headers,
          body: await streamBody(async function* () {
            yield encoder.encode(`event: meta\ndata: ${JSON.stringify({ requestId, model: m })}\n\n`);
            let buffer = "";
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += Buffer.from(value).toString("utf8");
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                yield encoder.encode(`event: chunk\ndata: ${trimmed}\n\n`);
              }
            }
            yield encoder.encode(`event: end\ndata: ${JSON.stringify({ model: m, took_ms: Date.now() - reqStart })}\n\n`);
          })
        };
      }
      // last model failed
      if (mi === candidates.length - 1) {
        return sseOnce.errorResp || resp(502, baseHeaders, { error: "All models failed (stream)", requestId });
      }
      // else: try next model
    }
  }

  // ============== NON-STREAM مع سقوط على نماذج أخرى + retries ==============
  for (let mi = 0; mi < candidates.length; mi++) {
    const m = candidates[mi];
    const url = makeUrl(m, false, API_KEY);
    const body = JSON.stringify({
      contents,
      generationConfig,
      ...(systemInstruction ? { systemInstruction } : {})
    });

    const jsonOnce = await tryJSONOnce(url, body, timeout_ms, include_raw);
    if (jsonOnce.ok) {
      return resp(200, baseHeaders, {
        text: jsonOnce.text,
        raw: include_raw ? jsonOnce.raw : undefined,
        model: m,
        requestId,
        took_ms: Date.now() - reqStart
      });
    }
    if (mi === candidates.length - 1) {
      const status = jsonOnce.statusCode || 502;
      return resp(status, baseHeaders, { ...(jsonOnce.error || { error: "All models failed" }), requestId });
    }
    // else: fallback to next model
  }

  return resp(500, baseHeaders, { error: "Unknown failure", requestId });
};

/* -------------------- Helpers -------------------- */

function resp(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj ?? {}) };
}

function clampNumber(n, min, max, fallback) {
  const v = Number.isFinite(+n) ? +n : fallback;
  return Math.max(min, Math.min(max, v));
}

function makeUrl(model, isStream, apiKey) {
  const base = "https://generativelanguage.googleapis.com/v1beta/models";
  const method = isStream ? "streamGenerateContent" : "generateContent";
  return `${base}/${encodeURIComponent(model)}:${method}?key=${apiKey}`;
}

/* ---- Messages & Media ---- */

function buildParts(prompt, images, audio) {
  const parts = [];
  if (typeof prompt === "string" && prompt.trim()) parts.push({ text: prompt });
  parts.push(...coerceMediaParts(images, audio));
  return parts;
}

function normalizeMessagesWithMedia(messages) {
  // Gemini expects: [{role:"user"|"model"|"system", parts:[{text|inline_data}...]}]
  const safeRole = (r) => (r === "user" || r === "model" || r === "system") ? r : "user";
  return messages
    .filter(m => m && (typeof m.content === "string" || m.images || m.audio))
    .map(m => {
      const parts = [];
      if (typeof m.content === "string" && m.content.trim()) parts.push({ text: m.content });
      parts.push(...coerceMediaParts(m.images, m.audio));
      return { role: safeRole(m.role), parts };
    })
    .filter(m => m.parts.length);
}

function coerceMediaParts(images, audio) {
  const parts = [];

  // images: [dataUrl | {mime,data}|{dataUrl}]
  if (Array.isArray(images)) {
    for (const item of images) {
      let mime, b64;
      if (typeof item === "string" && item.startsWith("data:")) {
        ({ mime, data: b64 } = fromDataUrl(item));
      } else if (item && typeof item === "object") {
        mime = item.mime || item.mime_type;
        b64 = item.data || item.base64 || (item.dataUrl ? fromDataUrl(item.dataUrl).data : "");
      }
      if (!mime || !b64) continue;
      if (!ALLOWED_IMAGE.test(mime)) continue;
      if (approxBase64Bytes(b64) > MAX_INLINE_BYTES) continue;
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    }
  }

  // audio: {mime,data} أو dataUrl string
  if (audio) {
    let mime, b64;
    if (typeof audio === "string" && audio.startsWith("data:")) {
      ({ mime, data: b64 } = fromDataUrl(audio));
    } else if (typeof audio === "object") {
      mime = audio.mime || audio.mime_type;
      b64 = audio.data || audio.base64 || (audio.dataUrl ? fromDataUrl(audio.dataUrl).data : "");
    }
    if (mime && b64 && ALLOWED_AUDIO.test(mime) && approxBase64Bytes(b64) <= MAX_INLINE_BYTES) {
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    }
  }

  return parts;
}

function fromDataUrl(dataUrl) {
  // data:[mime];base64,<data>
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(5, comma);
  const mime = header.includes(';') ? header.slice(0, header.indexOf(';')) : header;
  const data = dataUrl.slice(comma + 1);
  return { mime, data };
}

function approxBase64Bytes(b64) {
  const len = b64.length - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 0.75);
}

/* ---- Network & Retry ---- */

function shouldRetry(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function mapStatus(status) {
  if (status === 429) return 429;
  if (status >= 500) return 502;
  return status || 500;
}

function collectUpstreamError(status, data, text) {
  const details = (data && (data.error?.message || data.message)) || (typeof text === "string" ? text.slice(0, 1000) : "Upstream error");
  return { error: "Upstream error", status, details };
}

async function sleepWithJitter(attempt) {
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 400);
  await new Promise(r => setTimeout(r, base + jitter));
}

async function streamBody(genFactory) {
  const chunks = [];
  for await (const chunk of genFactory()) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

/* ---- One-shot attempts ---- */

async function tryStreamOnce(url, body, timeout_ms) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), timeout_ms);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: abort.signal });
      clearTimeout(t);
      if (!response.ok) {
        if (shouldRetry(response.status) && attempt < MAX_TRIES) { await sleepWithJitter(attempt); continue; }
        const text = await response.text();
        const data = safeParseJSON(text);
        const upstream = collectUpstreamError(response.status, data, text);
        return { ok: false, errorResp: resp(mapStatus(response.status), {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Content-Type": "application/json"
        }, upstream) };
      }
      return { ok: true, response };
    } catch (e) {
      clearTimeout(t);
      if (attempt < MAX_TRIES) { await sleepWithJitter(attempt); continue; }
      return { ok: false, errorResp: resp(500, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
      }, { error: "Network/timeout", details: String(e && e.message || e) }) };
    }
  }
}

async function tryJSONOnce(url, body, timeout_ms, include_raw) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), timeout_ms);
    try {
      const respUp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: abort.signal });
      clearTimeout(t);

      const textBody = await respUp.text();
      let data;
      try { data = JSON.parse(textBody); } catch { data = null; }

      if (!respUp.ok) {
        if (shouldRetry(respUp.status) && attempt < MAX_TRIES) { await sleepWithJitter(attempt); continue; }
        const upstream = collectUpstreamError(respUp.status, data, textBody);
        return { ok: false, statusCode: mapStatus(respUp.status), error: upstream };
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p?.text || "").join("\n").trim();
      if (!text) {
        const safety = data?.promptFeedback || data?.candidates?.[0]?.safetyRatings;
        return { ok: false, statusCode: 502, error: { error: "Empty/blocked response", safety, raw: include_raw ? data : undefined } };
      }
      return { ok: true, text, raw: include_raw ? data : undefined };
    } catch (e) {
      clearTimeout(t);
      if (attempt < MAX_TRIES) { await sleepWithJitter(attempt); continue; }
      return { ok: false, statusCode: 500, error: { error: "Network/timeout", details: String(e && e.message || e) } };
    }
  }
}

function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
