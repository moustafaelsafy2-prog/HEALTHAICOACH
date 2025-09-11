// netlify/functions/gemini-proxy.js
// Hardened multimodal proxy for Google Generative AI (Gemini)
// ✅ Supports: text + images (data URLs or {data, mime}) + audio ({data, mime})
// ✅ Optional: system instruction, chat history, JSON-mode
// ✅ Guards: blocks fake image analyses when no image is sent
// ✅ Clear errors + retries with backoff
// ✅ Returns extra metadata to help the frontend decide what to show

exports.handler = async (event) => {
  const baseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "GEMINI_API_KEY is missing" }) };
  }

  // ---------- Helpers ----------
  const parseJSON = (str) => { try { return JSON.parse(str || "{}"); } catch { return null; } };

  const isDataURL = (s) => typeof s === "string" && /^data:[^;]+;base64,/i.test(s || "");
  const parseDataURL = (s) => {
    // data:<mime>;base64,<payload>
    const m = /^data:([^;]+);base64,(.*)$/i.exec(s || "");
    if (!m) return null;
    return { mimeType: m[1], data: m[2] };
  };

  const cleanBase64 = (b64) => (b64 || "").replace(/^base64,/, "").replace(/\s+/g, "");

  const imageToInlineData = (item) => {
    if (!item) return null;
    if (typeof item === "string") {
      if (isDataURL(item)) return parseDataURL(item);
      return { mimeType: "image/jpeg", data: cleanBase64(item) };
    }
    if (typeof item === "object") {
      const data = cleanBase64(item.data || item.base64 || item.payload);
      const mimeType = item.mime || item.mimeType || "image/jpeg";
      if (!data) return null;
      return { mimeType, data };
    }
    return null;
  };

  const audioToInlineData = (audio) => {
    if (!audio || typeof audio !== "object") return null;
    const data = cleanBase64(audio.data || audio.base64 || audio.payload);
    const mimeType = audio.mime || audio.mimeType || "audio/webm";
    if (!data) return null;
    return { mimeType, data };
  };

  const looksLikeImageAnalysis = (text) => /(?:حل\s*ل|حلّ?ل|تحليل\s*الصورة|analy(?:s|z)e\s+(?:the|this)\s+(?:image|photo|picture))/i.test(text || "");

  // ---------- Parse request ----------
  const payload = parseJSON(event.body);
  if (!payload) {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const {
    prompt,
    model = "gemini-1.5-flash",
    temperature = 0.6,
    top_p = 0.9,
    max_output_tokens = 2048,
    system,                 // string
    images,                 // string dataURL[] or [{data, mime}] or raw base64[]
    audio,                  // { data, mime }
    response_mime_type,     // e.g. "application/json"
    require_images = false, // force images for image-analysis prompts
    history,                // [{ role: 'user'|'assistant', text }]
    safetySettings,         // optional passthrough
    timeout_ms              // optional custom timeout
  } = payload;

  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Missing prompt" }) };
  }

  // ---------- Build parts (images/audio first, then text) ----------
  const parts = [];

  const imageParts = Array.isArray(images)
    ? images.map(imageToInlineData).filter(Boolean).map(inlineData => ({ inlineData }))
    : [];
  parts.push(...imageParts);

  const audioPart = audioToInlineData(audio);
  if (audioPart) parts.push({ inlineData: audioPart });

  parts.push({ text: prompt });

  // Guard: block analysis without image content when it looks like an image task
  const wantsImage = require_images || looksLikeImageAnalysis(prompt);
  if (wantsImage && imageParts.length === 0 && !audioPart) {
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({ error: "IMAGE_REQUIRED", message: "No image content was provided for analysis." })
    };
  }

  // ---------- Build Gemini request ----------
  const reqBody = {
    contents: [ { role: "user", parts } ],
    generationConfig: {
      temperature,
      topP: top_p,
      maxOutputTokens: max_output_tokens
    }
  };

  if (response_mime_type && typeof response_mime_type === "string") {
    reqBody.generationConfig.responseMimeType = response_mime_type; // JSON-mode etc.
  }
  if (Array.isArray(history) && history.length) {
    const histContents = history.map(m => ({
      role: m && m.role === "assistant" ? "model" : "user",
      parts: [{ text: String((m && m.text) || "") }]
    })).filter(c => c.parts[0].text.length > 0);
    reqBody.contents = [...histContents, { role: "user", parts }];
  }
  if (system && typeof system === "string" && system.trim().length) {
    reqBody.systemInstruction = { parts: [{ text: system }] };
  }
  if (Array.isArray(safetySettings) && safetySettings.length) {
    reqBody.safetySettings = safetySettings; // passthrough when provided
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${API_KEY}`;

  // ---------- Fetch with retries ----------
  const MAX_TRIES = 3;
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);

  const doFetch = async () => {
    const abort = new AbortController();
    const to = setTimeout(() => abort.abort(), Math.max(1000, Math.min(60000, Number(timeout_ms) || 26000)));
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: abort.signal
      });
      clearTimeout(to);

      const rawText = await resp.text();
      let data; try { data = JSON.parse(rawText); } catch { data = null; }

      if (!resp.ok) {
        const details = (data && (data.error?.message || data.message)) || rawText.slice(0, 800);
        return { ok: false, status: resp.status, details, data };
      }

      const candidate = data?.candidates?.[0] || {};
      const partsOut = candidate?.content?.parts || [];
      const text = partsOut.map(p => p?.text || "").join("\n").trim();
      const finishReason = candidate?.finishReason || data?.promptFeedback?.blockReason || null;
      const safety = candidate?.safetyRatings || data?.promptFeedback || null;
      const usage = data?.usageMetadata || null;

      if (!text) {
        return { ok: false, status: 502, details: "Empty/blocked response", data: { safety, finishReason, raw: data } };
      }
      return { ok: true, status: 200, text, meta: { finishReason, safety, usage } };
    } catch (err) {
      return { ok: false, status: 500, details: String(err && err.message || err) };
    }
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const res = await doFetch();
    if (res.ok) {
      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ text: res.text, meta: res.meta }) };
    }
    lastErr = res;
    if (!RETRYABLE.has(res.status) || attempt === MAX_TRIES) break;
    await new Promise(r => setTimeout(r, attempt * 800));
  }

  const payloadErr = lastErr || { status: 500, details: "Unknown failure" };
  return { statusCode: payloadErr.status || 500, headers: baseHeaders, body: JSON.stringify({ error: payloadErr.details || "Upstream error", raw: payloadErr.data || null }) };
};
