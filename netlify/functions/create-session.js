// netlify/functions/create-session.js
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SESSIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/sessions`;

// util
const sha256hex = (s) =>
  crypto.createHash("sha256").update(s).digest("hex");

export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    // secret للمستخدم (لا يُحفظ نصيًا)
    const secret = crypto.randomBytes(24).toString("hex");
    const secret_hash = sha256hex(secret);

    // معلومات اختيارية
    const ip = event.headers["x-nf-client-connection-ip"] || "";
    const ua = event.headers["user-agent"] || "";

    // إنشاء صف بالـ REST API (بدون supabase-js لتفادي مشاكل ESM)
    const res = await fetch(SESSIONS_ENDPOINT, {
      method: "POST",
      headers: {
        apikey: SRK,
        Authorization: `Bearer ${SRK}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify([{ secret_hash, ip, user_agent: ua }]),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`supabase insert failed: ${t}`);
    }
    const [row] = await res.json();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: row.id,
        session_secret: secret,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}
