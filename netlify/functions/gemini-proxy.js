// netlify/functions/gemini-proxy.js
const looksLikeImageAnalysis = /(حلل|تحليل)\s*(?:الصورة|الصوره|image|photo|picture)/i.test(prompt);
const hasImages = imageParts.length > 0;
if ((require_images || looksLikeImageAnalysis) && !hasImages && !audioPart) {
return { statusCode: 422, headers: baseHeaders, body: JSON.stringify({ error: "IMAGE_REQUIRED", message: "No image content was provided for analysis." }) };
}


const reqBody = {
contents: [ { role: "user", parts } ],
generationConfig: { temperature, topP: top_p, maxOutputTokens: max_output_tokens }
};


if (response_mime_type && typeof response_mime_type === "string") {
reqBody.generationConfig.responseMimeType = response_mime_type;
}


if (Array.isArray(history) && history.length) {
const hist = history.map(m => ({ role: m && m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m && m.text || '') }] })).filter(c => c.parts[0].text.length);
reqBody.contents = [...hist, { role: 'user', parts }];
}


if (system && typeof system === "string" && system.trim().length) {
reqBody.systemInstruction = { parts: [{ text: system }] };
}


const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${API_KEY}`;


const MAX_TRIES = 3;
for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 26000);
try {
const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: abort.signal });
clearTimeout(timeout);
const textBody = await resp.text();
let data; try { data = JSON.parse(textBody); } catch { data = null; }


if (!resp.ok) {
const details = (data && (data.error?.message || data.message)) || textBody.slice(0, 600);
if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_TRIES) { await new Promise(r => setTimeout(r, attempt * 800)); continue; }
return { statusCode: resp.status, headers: baseHeaders, body: JSON.stringify({ error: 'Upstream error', details }) };
}


const partsOut = data?.candidates?.[0]?.content?.parts || [];
const text = partsOut.map(p => p?.text || '').join('\n').trim();
if (!text) {
const safety = data?.promptFeedback || data?.candidates?.[0]?.safetyRatings;
return { statusCode: 502, headers: baseHeaders, body: JSON.stringify({ error: 'Empty/blocked response', safety, raw: data }) };
}


return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ text }) };
} catch (err) {
clearTimeout(timeout);
if (attempt < MAX_TRIES) { await new Promise(r => setTimeout(r, attempt * 800)); continue; }
return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: String(err && err.message || err) }) };
}
}


return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'Unknown failure' }) };
};
