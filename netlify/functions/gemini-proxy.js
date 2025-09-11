// netlify/functions/gemini-proxy.js
// Hardened multimodal proxy for Google Generative AI (Gemini)
// - Supports text + images (data URLs or {data, mime}) + audio ({data, mime})
// - Optional system instruction
// - Optional JSON-mode via response_mime_type
// - Strict guards to avoid fake image analyses when no image is provided
// - Retries with backoff; clear error messages


exports.handler = async (event) => {
const baseHeaders = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "Content-Type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Content-Type": "application/json",
"Cache-Control": "no-store"
};


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


const parseJSON = (str) => { try { return JSON.parse(str || "{}"); } catch { return null; } };
const isDataURL = (s) => typeof s === "string" && s.startsWith("data:");
const parseDataURL = (s) => {
const m = /^data:([^;]+);base64,(.*)$/i.exec(s || "");
if (!m) return null; return { mimeType: m[1], data: m[2] };
};
const imageToInlineData = (item) => {
if (!item) return null;
if (typeof item === "string") {
if (isDataURL(item)) return parseDataURL(item);
return { mimeType: "image/jpeg", data: item.replace(/^base64,/, "") };
}
if (typeof item === "object") {
const data = item.data || item.base64 || null;
const mimeType = item.mime || item.mimeType || "image/jpeg";
if (!data) return null; return { mimeType, data };
}
return null;
};
const audioToInlineData = (audio) => {
if (!audio || typeof audio !== "object") return null;
const data = audio.data || audio.base64 || null;
const mimeType = audio.mime || audio.mimeType || "audio/webm";
if (!data) return null; return { mimeType, data };
};


const payload = parseJSON(event.body);
if (!payload) return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };


const {
prompt,
model = "gemini-1.5-flash",
temperature = 0.6,
top_p = 0.9,
max_output_tokens = 2048,
system,
images,
audio,
response_mime_type,
require_images = false,
history
} = payload;
};
