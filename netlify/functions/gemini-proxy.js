// netlify/functions/gemini-proxy.js
// Hardened, scalable proxy for Google Generative AI (Gemini) with streaming + retries

const MAX_TRIES = 4;                    // محاولات أكثر للحمل العالي
const BASE_BACKOFF_MS = 600;            // أساس الارتداد
const MAX_OUTPUT_TOKENS_HARD = 8192;    // حد أمان أعلى للتوكنات
const DEFAULT_TIMEOUT_MS = 26000;       // ضمن حدود Netlify
const SAFE_TEMP_RANGE = [0.0, 1.0];
const SAFE_TOPP_RANGE = [0.0, 1.0];

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

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return resp(405, baseHeaders, { error: "Method Not Allowed" });
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return resp(500, baseHeaders, { error: "GEMINI_API_KEY is missing" });
  }

  // Parse body safely
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return resp(400, baseHeaders, { error: "Invalid JSON" }); }

  // Inputs
  let {
    prompt,                      // string (اختياري لو messages موجود)
    messages,                    // [{role:"user"|"model"|"system", content:"..."}]
    model = "gemini-2.5-flash-preview-05-20",
    temperature = 0.6,
    top_p = 0.9,
    max_output_tokens = 2048,
    system,                      // string اختياري
    stream = false,              // بث لحظي
    timeout_ms = DEFAULT_TIMEOUT_MS,
    include_raw = false          // إرجاع الحمولة الخام اختيارياً
  } = payload || {};

  // Basic validation / clamping
  temperature = clampNumber(temperature, SAFE_TEMP_RANGE[0], SAFE_TEMP_RANGE[1], 0.6);
  top_p = clampNumber(top_p, SAFE_TOPP_RANGE[0], SAFE_TOPP_RANGE[1], 0.9);
  max_output_tokens = clampNumber(max_output_tokens, 1, MAX_OUTPUT_TOKENS_HARD, 2048);
  timeout_ms = clampNumber(timeout_ms, 1000, 29000, DEFAULT_TIMEOUT_MS);

  if (!prompt && !Array.isArray(messages)) {
    return resp(400, baseHeaders, { error: "Missing prompt or messages[]" });
  }

  // Build contents from messages or prompt
  const contents = Array.isArray(messages)
    ? normalizeMessages(messages)
    : [{ role: "user", parts: [{ text: String(prompt || "") }]}];

  const reqBody = {
    contents,
    generationConfig: { temperature, topP: top_p, maxOutputTokens: max_output_tokens }
  };
  if (system && typeof system === "string") {
    reqBody.systemInstruction = { role: "system", parts: [{ text: system }] };
  }

  const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
  const path = stream ? "streamGenerateContent" : "generateContent";
  const url = `${baseUrl}/${encodeURIComponent(model)}:${path}?key=${API_KEY}`;

  // Streaming branch
  if (stream) {
    // Netlify supports streaming with "event-stream" responses
    const headers = {
      ...baseHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    };

    try {
      const { response, errorResp } = await fetchWithRetries(url, reqBody, timeout_ms, true);
      if (errorResp) return errorResp;

      // Pipe SSE from Google -> client as NDJSON events
      const reader = response.body.getReader();
      const encoder = new TextEncoder();

      // Netlify Functions: return a streaming body via async generator
      return {
        statusCode: 200,
        headers,
        body: await streamBody(async function* () {
          yield encoder.encode(`event: meta\ndata: ${JSON.stringify({ requestId, model })}\n\n`);
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += Buffer.from(value).toString("utf8");

            // Gemini returns data as JSON lines; split safely
            const chunks = buffer.split("\n");
            buffer = chunks.pop() || "";

            for (const line of chunks) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              // Forward as-is to client for robustness
              yield encoder.encode(`event: chunk\ndata: ${trimmed}\n\n`);
            }
          }
          yield encoder.encode(`event: end\ndata: ${JSON.stringify({ ttfb_ms: Date.now() - reqStart })}\n\n`);
        })
      };
    } catch (err) {
      return resp(500, baseHeaders, { error: "Streaming failure", details: String(err && err.message || err), requestId });
    }
  }

  // Non-streaming branch
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeout_ms);

    try {
      const respUp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: abort.signal
      });
      clearTimeout(timeout);

      const textBody = await respUp.text();
      let data; try { data = JSON.parse(textBody); } catch { data = null; }

      if (!respUp.ok) {
        const upstream = collectUpstreamError(respUp.status, data, textBody);
        if (shouldRetry(respUp.status) && attempt < MAX_TRIES) {
          await sleepWithJitter(attempt);
          continue;
        }
        return resp(mapStatus(respUp.status), baseHeaders, { ...upstream, requestId });
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p?.text || "").join("\n").trim();

      if (!text) {
        const safety = data?.promptFeedback || data?.candidates?.[0]?.safetyRatings;
        return resp(502, baseHeaders, { error: "Empty/blocked response", safety, raw: include_raw ? data : undefined, requestId });
      }

      return resp(200, baseHeaders, {
        text,
        model,
        requestId,
        took_ms: Date.now() - reqStart,
        raw: include_raw ? data : undefined
      });

    } catch (err) {
      clearTimeout(timeout);
      if (attempt < MAX_TRIES) {
        await sleepWithJitter(attempt);
        continue;
      }
      return resp(500, baseHeaders, { error: "Network/timeout", details: String(err && err.message || err), requestId });
    }
  }

  return resp(500, baseHeaders, { error: "Unknown failure", requestId });
};

/* -------------------- helpers -------------------- */

function resp(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj ?? {}) };
}

function clampNumber(n, min, max, fallback) {
  const v = Number.isFinite(+n) ? +n : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeMessages(messages) {
  // Gemini expects: [{role:"user"|"model"|"system", parts:[{text:"..."}]}]
  const safeRole = (r) => (r === "user" || r === "model" || r === "system") ? r : "user";
  return messages
    .filter(m => m && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: safeRole(m.role), parts: [{ text: m.content }]}));
}

function shouldRetry(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function mapStatus(status) {
  // طبقًا لواجهتك الأمامية؛ نُرجع 4xx كما هي قدر الإمكان
  if (status === 429) return 429;
  if (status >= 500) return 502;
  return status || 500;
}

function collectUpstreamError(status, data, text) {
  const details = (data && (data.error?.message || data.message)) || (typeof text === "string" ? text.slice(0, 1000) : "Upstream error");
  return { error: "Upstream error", status, details };
}

async function sleepWithJitter(attempt) {
  // backoff أُسّي + jitter لمنع القطيع تحت الحمل
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt - 1); // 600, 1200, 2400, ...
  const jitter = Math.floor(Math.random() * 400);          // 0..399ms
  await new Promise(r => setTimeout(r, base + jitter));
}

// Wrap async generator into string for Netlify streaming
async function streamBody(genFactory) {
  const chunks = [];
  for await (const chunk of genFactory()) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

// Fetch with retries (streaming only: we retry just once before piping)
async function fetchWithRetries(url, body, timeout_ms, isStream) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), timeout_ms);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal
      });
      clearTimeout(t);
      if (!response.ok) {
        if (shouldRetry(response.status) && attempt < MAX_TRIES) {
          await sleepWithJitter(attempt);
          continue;
        }
        const text = await response.text();
        const data = safeParseJSON(text);
        const upstream = collectUpstreamError(response.status, data, text);
        return { errorResp: resp(mapStatus(response.status), {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Content-Type": "application/json",
          "X-Request-ID": (Math.random().toString(36).slice(2)).toUpperCase()
        }, upstream) };
      }
      return { response };
    } catch (e) {
      clearTimeout(t);
      if (attempt < MAX_TRIES) {
        await sleepWithJitter(attempt);
        continue;
      }
      return { errorResp: resp(500, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
      }, { error: "Network/timeout", details: String(e && e.message || e) }) };
    }
  }
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}
