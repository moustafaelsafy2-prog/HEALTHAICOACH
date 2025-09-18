// netlify/functions/gemini-proxy.js
// Pro-first, accuracy-tuned Gemini proxy with auto-continue for long answers,
// strict language mirroring (AR/EN), anti-hallucination guard, streaming, retries.

const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 600;
const MAX_OUTPUT_TOKENS_HARD = 8192;       // أقصى ما ندفعه للنموذج
const DEFAULT_TIMEOUT_MS = 28000;          // ضمن سقف Netlify
const SAFE_TEMP_RANGE = [0.0, 1.0];
const SAFE_TOPP_RANGE = [0.0, 1.0];

// Media limits
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i;
const ALLOWED_AUDIO = /^audio\/(webm|ogg|mp3|mpeg|wav|m4a|aac|3gpp|3gpp2|mp4)$/i;

// --- Pro-first pool لرفع الدقة ---
const MODEL_POOL = [
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-2.0-flash-exp",
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

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: baseHeaders, body: "" };
  if (event.httpMethod !== "POST") return resp(405, baseHeaders, { error: "Method Not Allowed" });

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return resp(500, baseHeaders, { error: "GEMINI_API_KEY is missing" });

  // Parse
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return resp(400, baseHeaders, { error: "Invalid JSON" }); }

  let {
    prompt,
    messages,
    images,
    audio,
    model = "auto",
    temperature,
    top_p,
    max_output_tokens,
    system,
    stream = false,
    timeout_ms = DEFAULT_TIMEOUT_MS,
    include_raw = false,

    // دوال الضبط
    mode,                       // "default" | "qa" | "image_brief"
    force_lang,                 // "ar" | "en"
    concise_image,              // boolean
    guard_level = "strict",     // "relaxed" | "strict"

    // --- جديد: تمكين ردود طويلة تلقائيًا ---
    long = true,                // فعّال افتراضيًا
    max_chunks = 4              // أقصى عدد دفعات للتكملة داخل نفس الطلب
  } = payload || {};

  if (!prompt && !Array.isArray(messages)) {
    return resp(400, baseHeaders, { error: "Missing prompt or messages[]" });
  }

  timeout_ms = clampNumber(timeout_ms, 1000, 29000, DEFAULT_TIMEOUT_MS);

  // --------- لغة المستخدم + حراسة ----------
  const contentPreview = textPreview(prompt || messages?.map(m=>m?.content||"").join("\n"));
  const lang = chooseLang(force_lang, contentPreview);
  const hasTopImages  = Array.isArray(images) && images.length > 0;
  const hasAnyImages  = hasTopImages || !!(Array.isArray(messages) && messages.some(m=>Array.isArray(m.images) && m.images.length));
  const useImageBrief = concise_image === true || mode === "image_brief" || hasAnyImages;

  const guard = buildGuardrails({ lang, useImageBrief, level: guard_level });

  const contents = Array.isArray(messages)
    ? normalizeMessagesWithMedia(messages, guard)
    : [{ role: "user", parts: buildParts(wrapPrompt(prompt, lang, useImageBrief, guard), images, audio) }];

  const generationConfig = tuneGeneration({ temperature, top_p, max_output_tokens, useImageBrief, mode });
  const safetySettings   = buildSafety(guard_level);

  const systemInstruction = (system && typeof system === "string")
    ? { role: "system", parts: [{ text: system } ] }
    : undefined;

  const candidates = (model === "auto" || !model)
    ? [...MODEL_POOL]
    : Array.from(new Set([model, ...MODEL_POOL]));

  // ======= STREAM (SSE) =======
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
      const body = JSON.stringify({ contents, generationConfig, safetySettings, ...(systemInstruction ? { systemInstruction } : {}) });

      const sseOnce = await tryStreamOnce(url, body, timeout_ms);
      if (sseOnce.ok) {
        const reader = sseOnce.response.body.getReader();
        const encoder = new TextEncoder();
        return {
          statusCode: 200,
          headers,
          body: await streamBody(async function* () {
            yield encoder.encode(`event: meta\ndata: ${JSON.stringify({ requestId, model: m, lang })}\n\n`);
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
    }
  }

  // ======= NON-STREAM + Fallback + Auto-Continue =======
  for (let mi = 0; mi < candidates.length; mi++) {
    const m = candidates[mi];
    const url = makeUrl(m, false, API_KEY);

    const makeBody = () => JSON.stringify({
      contents,
      generationConfig,
      safetySettings,
      ...(systemInstruction ? { systemInstruction } : {})
    });

    // المرة الأولى
    const first = await tryJSONOnce(url, makeBody(), timeBudgetLeft(reqStart, timeout_ms), include_raw);
    if (!first.ok) {
      if (mi === candidates.length - 1) {
        const status = first.statusCode || 502;
        return resp(status, baseHeaders, { ...(first.error || { error: "All models failed" }), requestId, lang });
      }
      continue; // جرّب النموذج التالي
    }

    let fullText = first.text;
    let chunks = 1;

    // تكملة تلقائية داخل نفس الطلب لإخراج نص طويل بدون تكرار
    while (long && chunks < clampNumber(max_chunks, 1, 12, 4) && shouldContinue(fullText) && timeBudgetLeft(reqStart, timeout_ms) > 2500) {
      // أضف ردّ النموذج كسياق، ثم اطلب "تابع" بنفس اللغة وبدون تكرار
      contents.push({ role: "model", parts: [{ text: fullText }] });
      contents.push({ role: "user", parts: [{ text: continuePrompt(lang) }] });

      const next = await tryJSONOnce(url, makeBody(), timeBudgetLeft(reqStart, timeout_ms), false);
      if (!next.ok) break;

      // إزالة أي تكرار افتتاحي شائع
      const append = dedupeContinuation(fullText, next.text);
      fullText += (append ? ("\n" + append) : "");
      chunks++;
    }

    return resp(200, baseHeaders, {
      text: mirrorLanguage(fullText, lang),
      model: m,
      lang,
      usage: first.usage || undefined,
      requestId,
      took_ms: Date.now() - reqStart
    });
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
    ? `**ملاحظة:** الرد باللغة العربية فقط.\n\n${text}`
    : `**Note:** Response in English only.\n\n${text}`;
}

function textPreview(s){ return (s || "").slice(0, 6000); }

/* ---- Guardrails ---- */
function buildGuardrails({ lang, useImageBrief, level }){
  const L = (lang === "ar") ? {
    mirror: "أجب حصراً بنفس لغة المستخدم الظاهرة (العربية). لا تخلط لغتين. لا تُدرج ترجمة.",
    beBrief: "اختصر الحشو وركّز على خطوات قابلة للتنفيذ وصياغة بشرية طبيعية.",
    imageBrief: "عند وجود صور: أعطِ 3–5 نقاط تنفيذية دقيقة + خطوة واحدة فورية. بدون مقدمات.",
    strict: "لا تختلق. عند الشك اطلب التوضيح. اذكر الافتراضات والوحدات. اعرض الحسابات والأرقام بدقة وتحقق منها. التزم بتعليمات التوجيه حرفيًا."
  } : {
    mirror: "Answer strictly in the user's language (English). Do not mix languages or add translations.",
    beBrief: "Cut fluff, focus on precise, executable steps in a human tone.",
    imageBrief: "If images exist: return 3–5 precise actionable bullets + one immediate step. No preamble.",
    strict: "Never fabricate. If uncertain, ask for the missing detail. State assumptions/units. Show calculations accurately and verify. Follow system instructions exactly."
  };
  const lines = [L.mirror, L.beBrief, (useImageBrief ? L.imageBrief : ""), (level !== "relaxed" ? L.strict : "")].filter(Boolean);
  return lines.join("\n");
}
function wrapPrompt(prompt, lang, useImageBrief, guard){
  const head = (lang === "ar") ? "تعليمات حراسة موجزة (اتبعها بدقة):" : "Concise guardrails (follow strictly):";
  return `${head}\n${guard}\n\n---\n${prompt || ""}`;
}

/* ---- Messages & Media ---- */

function buildParts(prompt, images, audio) {
  const parts = [];
  if (typeof prompt === "string" && prompt.trim()) parts.push({ text: prompt });
  parts.push(...coerceMediaParts(images, audio));
  return parts;
}
function normalizeMessagesWithMedia(messages, guard) {
  const safeRole = (r) => (r === "user" || r === "model" || r === "system") ? r : "user";
  let injected = false;
  return messages
    .filter(m => m && (typeof m.content === "string" || m.images || m.audio))
    .map(m => {
      const parts = [];
      if (!injected && m.role === "user") {
        const content = (typeof m.content === "string" && m.content.trim()) ? m.content : "";
        parts.push({ text: wrapPrompt(content, chooseLang(undefined, content), !!(m.images && m.images.length), guard) });
        injected = true;
      } else if (typeof m.content === "string" && m.content.trim()) {
        parts.push({ text: m.content });
      }
      parts.push(...coerceMediaParts(m.images, m.audio));
      return { role: safeRole(m.role), parts };
    })
    .filter(m => m.parts.length);
}

function coerceMediaParts(images, audio) {
  const parts = [];
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

/* ---- Generation tuning (دقّة) ---- */
function tuneGeneration({ temperature, top_p, max_output_tokens, useImageBrief, mode }) {
  let t   = (temperature   === undefined || temperature   === null) ? (useImageBrief ? 0.25 : 0.30) : temperature;
  let tp  = (top_p         === undefined || top_p         === null) ? 0.88 : top_p;
  let mot = (max_output_tokens === undefined || max_output_tokens === null)
              ? (useImageBrief ? 1536 : 6144)
              : max_output_tokens;

  if (mode === "qa" || mode === "factual") {
    t = Math.min(t, 0.24);
    tp = Math.min(tp, 0.9);
    mot = Math.max(mot, 3072);
  }

  t   = clampNumber(t,   SAFE_TEMP_RANGE[0], SAFE_TEMP_RANGE[1], 0.30);
  tp  = clampNumber(tp,  SAFE_TOPP_RANGE[0], SAFE_TOPP_RANGE[1], 0.88);
  mot = clampNumber(mot, 1, MAX_OUTPUT_TOKENS_HARD, 6144);

  return { temperature: t, topP: tp, maxOutputTokens: mot };
}

/* ---- Safety ---- */
function buildSafety(level = "strict") {
  const cat = (name) => ({ category: name, threshold: level === "relaxed" ? "BLOCK_NONE" : "BLOCK_ONLY_HIGH" });
  return [
    cat("HARM_CATEGORY_HARASSMENT"),
    cat("HARM_CATEGORY_HATE_SPEECH"),
    cat("HARM_CATEGORY_SEXUALLY_EXPLICIT"),
    cat("HARM_CATEGORY_DANGEROUS_CONTENT"),
  ];
}

/* ---- Auto-continue helpers ---- */
function continuePrompt(lang){
  return (lang === "ar")
    ? "تابع من حيث توقفت بنفس الهيكل واللغة، بدون تكرار أو تلخيص لما سبق، وأكمل مباشرة."
    : "Continue exactly where you stopped, same structure and language, no repetition or summary; output only the continuation.";
}
function shouldContinue(text){
  if (!text) return false;
  // اشارات انتهاء غير مؤكدة → واصل
  const tail = text.slice(-40).trim();
  return /[\u2026…]$/.test(tail) || /(?:continued|to be continued)[:.]?$/i.test(tail) || tail.endsWith("-");
}
function dedupeContinuation(prev, next){
  if (!next) return "";
  // إزالة افتتاحية مكررة (حتى 200 حرف)
  const head = next.slice(0, 200);
  if (prev && prev.endsWith(head)) return next.slice(head.length).trimStart();
  return next;
}
function timeBudgetLeft(start, total){ return Math.max(0, total - (Date.now() - start)); }

/* ---- Network & Retry ---- */
function shouldRetry(status) { return status === 429 || (status >= 500 && status <= 599); }
function mapStatus(status) { if (status === 429) return 429; if (status >= 500) return 502; return status || 500; }
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
      let data; try { data = JSON.parse(textBody); } catch { data = null; }

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

