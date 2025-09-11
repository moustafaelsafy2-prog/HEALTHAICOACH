// netlify/functions/gemini-proxy.js
// Hardened multimodal proxy for Google Generative AI (Gemini)
// - Supports text + images (data URLs or {data, mime}) + audio ({data, mime})
// - Optional system instruction
// - Optional JSON-mode via response_mime_type
// - Strict guards to avoid "example" image analyses when no image is provided
// - Retries with backoff; clear error messages

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

  // ---- Helpers ----
  const parseJSON = (str) => { try { return JSON.parse(str || "{}"); } catch { return null; } };

  const isDataURL = (s) => typeof s === "string" && s.startsWith("data:");
  const parseDataURL = (s) => {
    // data:<mime>;base64,<payload>
    const m = /^data:([^;]+);base64,(.*)$/i.exec(s || "");
    if (!m) return null;
    return { mimeType: m[1], data: m[2] };
  };

  const imageToInlineData = (item) => {
    if (!item) return null;
    if (typeof item === "string") {
      if (isDataURL(item)) return parseDataURL(item);
      // Assume it's raw base64 (jpeg by default)
      return { mimeType: "image/jpeg", data: item.replace(/^base64,/, "") };
    }
    if (typeof item === "object") {
      const data = item.data || item.base64 || null;
      const mimeType = item.mime || item.mimeType || "image/jpeg";
      if (!data) return null;
      return { mimeType, data };
    }
    return null;
  };

  const audioToInlineData = (audio) => {
    if (!audio || typeof audio !== "object") return null;
    const data = audio.data || audio.base64 || null;
    const mimeType = audio.mime || audio.mimeType || "audio/webm";
    if (!data) return null;
    return { mimeType, data };
  };

  // ---- Parse request body ----
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
    system,                   // optional system instruction (string)
    images,                   // array of data URLs or [{data, mime}]
    audio,                    // { data, mime }
    response_mime_type,       // e.g. "application/json" to force JSON output
    require_images = false,   // if true, reject when analyzing image without images
    history                   // optional: [{ role: 'user'|'assistant', text: '...' }]
  } = payload;

  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Missing prompt" }) };
  }

  // ---- Build parts (images/audio first, then text) ----
  const parts = [];

  const imageParts = Array.isArray(images)
    ? images.map(imageToInlineData).filter(Boolean).map(inlineData => ({ inlineData }))
    : [];
  parts.push(...imageParts);

  const audioPart = audioToInlineData(audio);
  if (audioPart) parts.push({ inlineData: audioPart });

  parts.push({ text: prompt });

  // ---- Defensive guard: if the prompt clearly asks to analyze an image but none provided ----
  const looksLikeImageAnalysis = /(?:حل[\- ]?ل|حلّ?ل|حلل|حل(?:ل)?|حلل\s*الصورة|حلل الصورة|حلّل الصورة|حل الصورة|تحليل الصورة|analy(?:s|z)e\s+(?:an\s+)?image|analyze\s+(?:this|the)\s+(?:image|photo|picture))/i.test(prompt);
  const hasImages = imageParts.length > 0;

  if ((require_images || looksLikeImageAnalysis) && !hasImages && !audioPart) {
    // Return a strict error so the frontend can show a friendly toast instead of the model hallucinating
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({ error: "IMAGE_REQUIRED", message: "No image content was provided for analysis." })
    };
  }

  // ---- Build request body for Gemini ----
  const reqBody = {
    contents: [
      { role: "user", parts }
    ],
    generationConfig: {
      temperature,
      topP: top_p,
      maxOutputTokens: max_output_tokens
    }
  };

  if (response_mime_type && typeof response_mime_type === "string") {
    // Supported on 1.5 models; ignored gracefully by older models
    reqBody.generationConfig.responseMimeType = response_mime_type;
  }

  if (Array.isArray(history) && history.length) {
    // Prepend chat history (older -> newer) before the latest user turn
    const histContents = history.map(m => ({
      role: m && m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m && m.text || "") }]
    })).filter(c => c.parts[0].text.length > 0);
    reqBody.contents = [...histContents, { role: "user", parts }];
  }

  if (system && typeof system === "string" && system.trim().length) {
    reqBody.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${API_KEY}`;

  // ---- Fetch with retries ----
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 26000); // 26s timeout

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: abort.signal
      });
      clearTimeout(timeout);

      const textBody = await resp.text();
      let data; try { data = JSON.parse(textBody); } catch { data = null; }

      if (!resp.ok) {
        const details = (data && (data.error?.message || data.message)) || textBody.slice(0, 600);
        if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_TRIES) {
          await new Promise(r => setTimeout(r, attempt * 800));
          continue;
        }
        return { statusCode: resp.status, headers: baseHeaders, body: JSON.stringify({ error: "Upstream error", details }) };
      }

      const partsOut = data?.candidates?.[0]?.content?.parts || [];
      const text = partsOut.map(p => p?.text || "").join("\n").trim();

      if (!text) {
        const safety = data?.promptFeedback || data?.candidates?.[0]?.safetyRatings;
        return { statusCode: 502, headers: baseHeaders, body: JSON.stringify({ error: "Empty/blocked response", safety, raw: data }) };
      }

      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ text }) };
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < MAX_TRIES) {
        await new Promise(r => setTimeout(r, attempt * 800));
        continue;
      }
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: String(err && err.message || err) }) };
    }
  }

  // Should not reach
  return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Unknown failure" }) };
};
