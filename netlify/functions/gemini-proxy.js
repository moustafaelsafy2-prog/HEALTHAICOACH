// netlify/functions/gemini-proxy.js
// Gemini proxy: multi-model fallback, vision+audio inline, streaming, retries, strict guards,
// auto language mirroring (AR/EN), and concise vision mode for short, actionable replies.

const MAX_TRIES = 3;                     // محاولات لكل نموذج
const BASE_BACKOFF_MS = 600;             // ارتداد أُسّي مع jitter
const MAX_OUTPUT_TOKENS_HARD = 8192;     // حد أقصى آمن للتوكنات
const DEFAULT_TIMEOUT_MS = 26000;        // ضمن حدود Netlify
const SAFE_TEMP_RANGE = [0.0, 1.0];
const SAFE_TOPP_RANGE = [0.0, 1.0];

// حدود الوسائط
const MAX_INLINE_BYTES = 15 * 1024 * 1024; // 15MB/part
const MAX_INLINE_BYTES_TOTAL = 60 * 1024 * 1024; // إجمالي 60MB للطلب (حماية لطيفة)
const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i;
const ALLOWED_AUDIO = /^audio\/(webm|ogg|mp3|mpeg|wav|m4a|aac|3gpp|3gpp2|mp4)$/i;

// ترتيب نماذج جيميني المرشحة
const MODEL_POOL = [
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
    "Access-Control-Allow-Headers": "Content-Type, X-Request-ID, Authorization",
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

  // Inputs (+ معلمات إضافية للتكامل)
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
    include_raw = false,

    // ---- New tuning knobs ----
    mode,                // "default" | "image_brief" | "qa" (مستقبلاً)
    force_lang,          // "ar" | "en" | undefined
    concise_image,       // boolean: يفرض ردًا موجزًا عند وجود صور
    guard_level = "strict" // "relaxed" | "strict" — يؤثر على قوالب الحراسة فقط
  } = payload || {};

  // Validate/clamp
  temperature = clampNumber(temperature, SAFE_TEMP_RANGE[0], SAFE_TEMP_RANGE[1], 0.6);
  top_p = clampNumber(top_p, SAFE_TOPP_RANGE[0], SAFE_TOPP_RANGE[1], 0.9);
  max_output_tokens = clampNumber(max_output_tokens, 1, MAX_OUTPUT_TOKENS_HARD, 2048);
  timeout_ms = clampNumber(timeout_ms, 1000, 29000, DEFAULT_TIMEOUT_MS);

  if (!prompt && !Array.isArray(messages)) {
    return resp(400, baseHeaders, { error: "Missing prompt or messages[]" });
  }

  // --------- Guardrails & Language mirroring ----------
  const contentPreview = textPreview(prompt || messages?.map(m=>m?.content||"").join("\n"));
  const lang = chooseLang(force_lang, contentPreview);

  // ====== Build contents + media (with strict image checks) ======
  // نجمع كل الصور لتجميع الحجم الإجمالي ومن ثم نعيد استخدامها.
  // نُطَبِّع الإدخالات: dataURL أو {mime,data} أو {dataUrl}
  const normalizedTopImages = normalizeImageInputs(images);
  const normalizedMsgImages = Array.isArray(messages)
    ? messages.flatMap(m => normalizeImageInputs(m?.images)).filter(Boolean)
    : [];
  const allCandidateImages = [...normalizedTopImages, ...normalizedMsgImages];

  const { acceptedParts: acceptedImageParts, totalBytes, rejected } =
    enforceImageLimits(allCandidateImages, MAX_INLINE_BYTES, MAX_INLINE_BYTES_TOTAL);

  // لو كل الصور رُفضت وكان المُدخل يحتوي صورًا => نُرجع خطأ واضح بدل “تجاهل”
  const hadAnyImages = allCandidateImages.length > 0;
  const hasAcceptedImages = acceptedImageParts.length > 0;
  if (hadAnyImages && !hasAcceptedImages) {
    return resp(413, baseHeaders, {
      error: "All images were rejected",
      reason: "Unsupported type or size exceeds limits",
      per_image_limit_mb: Math.round(MAX_INLINE_BYTES / 1024 / 1024),
      total_limit_mb: Math.round(MAX_INLINE_BYTES_TOTAL / 1024 / 1024),
      rejected: rejected.map(r => ({ mime: r.mime, approx_bytes: r.bytes }))
    });
  }

  const hasAnyImages = hasAcceptedImages;
  const useImageBrief = concise_image === true || mode === "image_brief" || hasAnyImages;

  // حقن تعليمات حراسة قصيرة — تُضاف قبل محتوى المستخدم
  const guard = buildGuardrails({ lang, useImageBrief, level: guard_level });

  // Build contents from messages or single prompt
  const contents = Array.isArray(messages)
    ? normalizeMessagesWithMedia(messages, guard, acceptedImageParts)
    : [{
        role: "user",
        parts: [{ text: wrapPrompt(prompt, lang, useImageBrief, guard) }, ...acceptedImageParts, ...coerceAudioPart(audio)]
      }];

  const generationConfig = { temperature, topP: top_p, maxOutputTokens: max_output_tokens };
  const systemInstruction = (system && typeof system === "string")
    ? { role: "system", parts: [{ text: system } ] }
    : undefined;

  // Candidate models order
  const candidates = (model === "auto" || !model)
    ? [...MODEL_POOL]
    : Array.from(new Set([model, ...MODEL_POOL])); // جرّب المطلوب أولًا ثم الباقي

  // ================== STREAMING (SSE) ==================
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
            yield encoder.encode(`event: meta\ndata: ${JSON.stringify({ requestId, model: m, lang, total_image_bytes: totalBytes })}\n\n`);
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
      if (mi === candidates.length - 1) {
        return sseOnce.errorResp || resp(502, baseHeaders, { error: "All models failed (stream)", requestId, lang });
      }
      // else: try next model
    }
  }

  // ================== NON-STREAM + Fallback ==================
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
        text: mirrorLanguage(jsonOnce.text, lang), // ضمان المرآة اللغوية
        raw: include_raw ? jsonOnce.raw : undefined,
        model: m,
        lang,
        usage: jsonOnce.usage || undefined,
        requestId,
        took_ms: Date.now() - reqStart
      });
    }
    if (mi === candidates.length - 1) {
      const status = jsonOnce.statusCode || 502;
      return resp(status, baseHeaders, { ...(jsonOnce.error || { error: "All models failed" }), requestId, lang });
    }
    // else: fallback to next model
  }

  return resp(500, baseHeaders, { error: "Unknown failure", requestId, lang });
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

function hasArabic(s){ return /[\u0600-\u06FF]/.test(s || "") }
function chooseLang(force, sample){
  if(force === "ar" || force === "en") return force;
  return hasArabic(sample) ? "ar" : "en";
}
function mirrorLanguage(text, lang){
  if(!text) return text;
  if(lang === "ar" && hasArabic(text)) return text;
  if(lang === "en" && !hasArabic(text)) return text;
  return (lang === "ar")
    ? `**ملاحظة:** الرد باللغة العربية.\n\n${text}`
    : `**Note:** Response in English.\n\n${text}`;
}

function textPreview(s){
  if(!s) return "";
  return (s || "").slice(0, 6000); // معاينة كافية لاختيار اللغة فقط
}

/* ---- Guardrails ---- */

function buildGuardrails({ lang, useImageBrief, level }){
  const L = (lang === "ar") ? {
    mirror: "استخدم نفس لغة المستخدم تلقائيًا (العربية إن كانت ظاهرة).",
    beBrief: "كن موجزًا وعمليًا بدون مقدمات أو اعتذارات.",
    imageBrief: `إن كانت هناك صورة: قدّم 3–5 نقاط تنفيذية مختصرة + خطوة واحدة الآن. لا مقدّمات.`,
    strict: "تجنّب العموميات والحشو. استخدم نقاط واضحة قابلة للتنفيذ.",
  } : {
    mirror: "Mirror the user's language automatically (English if detected).",
    beBrief: "Be concise and practical. No preambles or apologies.",
    imageBrief: `If an image is present: return 3–5 tight, actionable bullets + one immediate step. No preamble.`,
    strict: "Avoid vagueness and fluff. Use clear, executable bullets."
  };
  const lines = [L.mirror, L.beBrief, (useImageBrief ? L.imageBrief : ""), (level !== "relaxed" ? L.strict : "")].filter(Boolean);
  return lines.join("\n");
}

function wrapPrompt(prompt, lang, useImageBrief, guard){
  const head = (lang === "ar")
    ? "تعليمات حراسة موجزة (اتبعها بدقة):"
    : "Concise guardrails (follow strictly):";
  return `${head}\n${guard}\n\n---\n${prompt || ""}`;
}

/* ---- Messages & Media ---- */

// (1) تطبيع مدخلات الصور القادمة من الواجهة (dataURL | {mime,data}|{dataUrl})
function normalizeImageInputs(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const out = [];
  for (const item of images) {
    if (typeof item === "string" && item.startsWith("data:")) {
      const { mime, data } = fromDataUrl(item);
      out.push({ mime, data, _bytes: approxBase64Bytes(data) });
    } else if (item && typeof item === "object") {
      let mime = item.mime || item.mime_type;
      let b64 = item.data || item.base64 || (item.dataUrl ? fromDataUrl(item.dataUrl).data : "");
      if (typeof item === "object" && !mime && typeof item.dataUrl === "string") {
        mime = fromDataUrl(item.dataUrl).mime;
      }
      if (mime && b64) out.push({ mime, data: b64, _bytes: approxBase64Bytes(b64) });
    }
  }
  return out;
}

// (2) فرض حدود الحجم ونوع الملف — نُرجع الأجزاء المقبولة + المرفوضة
function enforceImageLimits(normalized, perImageLimit, totalLimit) {
  const acceptedParts = [];
  const rejected = [];
  let totalBytes = 0;
  for (const img of normalized) {
    const bytes = img._bytes ?? approxBase64Bytes(img.data || "");
    const mime = img.mime || "";
    const validType = ALLOWED_IMAGE.test(mime);
    const withinPerPart = bytes > 0 && bytes <= perImageLimit;
    const withinTotal = totalBytes + bytes <= totalLimit;
    if (validType && withinPerPart && withinTotal) {
      acceptedParts.push({ inline_data: { mime_type: mime, data: img.data } });
      totalBytes += bytes;
    } else {
      rejected.push({ mime, bytes, reason: !validType ? "type" : (!withinPerPart ? "per-part" : "total") });
    }
  }
  return { acceptedParts, rejected, totalBytes };
}

function coerceAudioPart(audio) {
  const parts = [];
  if (!audio) return parts;
  let mime, b64;
  if (typeof audio === "string" && audio.startsWith("data:")) {
    ({ mime, data: b64 } = fromDataUrl(audio));
  } else if (audio && typeof audio === "object") {
    mime = audio.mime || audio.mime_type;
    b64 = audio.data || audio.base64 || (audio.dataUrl ? fromDataUrl(audio.dataUrl).data : "");
  }
  if (mime && b64 && ALLOWED_AUDIO.test(mime) && approxBase64Bytes(b64) <= MAX_INLINE_BYTES) {
    parts.push({ inline_data: { mime_type: mime, data: b64 } });
  }
  return parts;
}

function normalizeMessagesWithMedia(messages, guard, acceptedImagePartsFromTop) {
  // Gemini expects: [{role:"user"|"model"|"system", parts:[{text|inline_data}...]}]
  const safeRole = (r) => (r === "user" || r === "model" || r === "system") ? r : "user";
  let injected = false;
  return messages
    .filter(m => m && (typeof m.content === "string" || m.images || m.audio))
    .map(m => {
      const parts = [];
      // حقن الحراسة مرة واحدة في أول رسالة user فقط
      if (!injected && m.role === "user") {
        const content = (typeof m.content === "string" && m.content.trim()) ? m.content : "";
        parts.push({ text: wrapPrompt(content, chooseLang(undefined, content), !!(m.images && m.images.length), guard) });
        injected = true;
        // دمج الصور العليا إن وُجدت مرة واحدة في أول رسالة
        if (Array.isArray(acceptedImagePartsFromTop) && acceptedImagePartsFromTop.length) {
          parts.push(...acceptedImagePartsFromTop);
        }
      } else if (typeof m.content === "string" && m.content.trim()) {
        parts.push({ text: m.content });
      }
      // صور خاصة بهذه الرسالة
      const msgImgs = normalizeImageInputs(m.images);
      const { acceptedParts } = enforceImageLimits(msgImgs, MAX_INLINE_BYTES, MAX_INLINE_BYTES_TOTAL);
      parts.push(...acceptedParts);
      // الصوت
      parts.push(...coerceAudioPart(m.audio));
      return { role: safeRole(m.role), parts };
    })
    .filter(m => m.parts.length);
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
  if (!b64 || typeof b64 !== "string") return 0;
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
          "Access-Control-Allow-Headers": "Content-Type, X-Request-ID, Authorization",
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
        "Access-Control-Allow-Headers": "Content-Type, X-Request-ID, Authorization",
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
      const usage = data?.usageMetadata ? {
        promptTokenCount: data.usageMetadata.promptTokenCount,
        candidatesTokenCount: data.usageMetadata.candidatesTokenCount,
        totalTokenCount: data.usageMetadata.totalTokenCount
      } : undefined;

      return { ok: true, text, raw: include_raw ? data : undefined, usage };
    } catch (e) {
      clearTimeout(t);
      if (attempt < MAX_TRIES) { await sleepWithJitter(attempt); continue; }
      return { ok: false, statusCode: 500, error: { error: "Network/timeout", details: String(e && e.message || e) } };
    }
  }
}

function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
