// netlify/functions/gemini-proxy.js
// Hardened proxy for Google Generative AI (Gemini)

exports.handler = async (event) => {
  const baseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
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

  // Parse body
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const {
    prompt,
    model = "gemini-2.5-flash-preview-05-20",   // يمكنك تغييره هنا افتراضياً
    temperature = 0.6,
    top_p = 0.9,
    max_output_tokens = 2048,
    system // اختياري: تعليمات نظام
  } = payload || {};

  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Missing prompt" }) };
  }

  // Build request body
  const reqBody = {
    contents: [{ parts: [{ text: prompt }]}],
    generationConfig: { temperature, topP: top_p, maxOutputTokens: max_output_tokens }
  };
  if (system && typeof system === "string") reqBody.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${API_KEY}`;

  // Retry with backoff for transient failures
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 26000); // 26s within Netlify limit

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
        // Upstream error
        const details = (data && (data.error?.message || data.message)) || textBody.slice(0, 600);
        // Retry on 429/5xx
        if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_TRIES) {
          await new Promise(r => setTimeout(r, attempt * 800)); // backoff: 0.8s, 1.6s
          continue;
        }
        return { statusCode: resp.status, headers: baseHeaders, body: JSON.stringify({ error: "Upstream error", details }) };
      }

      // Extract text safely (parts may be multiple)
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p?.text || "").join("\n").trim();

      if (!text) {
        // Safety blocked / empty
        const safety = data?.promptFeedback || data?.candidates?.[0]?.safetyRatings;
        return { statusCode: 502, headers: baseHeaders, body: JSON.stringify({ error: "Empty/blocked response", safety, raw: data }) };
      }

      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ text }) };
    } catch (err) {
      clearTimeout(timeout);
      // Retry on abort/network only
      if (attempt < MAX_TRIES) {
        await new Promise(r => setTimeout(r, attempt * 800));
        continue;
      }
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: String(err && err.message || err) }) };
    }
  }

  // Fallback (should not reach)
  return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Unknown failure" }) };
};

