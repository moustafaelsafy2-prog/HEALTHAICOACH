// netlify/functions/chat.js
import crypto from "crypto";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SRK } = process.env;

const SESSIONS = `${SUPABASE_URL}/rest/v1/sessions`;
const MESSAGES = `${SUPABASE_URL}/rest/v1/messages`;

const sha256hex = (s) =>
  crypto.createHash("sha256").update(s).digest("hex");

const ok = (b) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(b),
});
const bad = (m, c = 400) => ({ statusCode: c, body: JSON.stringify({ error: m }) });

// تحميل secret_hash للجلسة
async function getSecretHash(session_id) {
  const url = `${SESSIONS}?id=eq.${encodeURIComponent(
    session_id
  )}&select=secret_hash`;
  const r = await fetch(url, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  if (!r.ok) throw new Error(`fetch session failed: ${await r.text()}`);
  const [row] = await r.json();
  if (!row) throw new Error("session_not_found");
  return row.secret_hash;
}

// التحقق من التوقيع
function verify({ session_id, timestamp, bodyText, signature, secret_hash, proof }) {
  // مهلة 5 دقائق
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000)
    return false;

  // يجب أن يكون hash(proof) == secret_hash
  if (sha256hex(proof) !== secret_hash) return false;

  // signature = sha256(session_id + proof + timestamp + bodyText)
  const expect = sha256hex(session_id + proof + timestamp + bodyText);
  return expect === signature;
}

export async function handler(event) {
  try {
    if (event.httpMethod === "GET") {
      const { session_id, proof, timestamp, signature } =
        event.queryStringParameters || {};
      if (!session_id || !proof || !timestamp || !signature)
        return bad("missing_params");

      const secret_hash = await getSecretHash(session_id);
      if (!verify({ session_id, timestamp, bodyText: "", signature, secret_hash, proof }))
        return bad("invalid_signature", 401);

      const url = `${MESSAGES}?session_id=eq.${encodeURIComponent(
        session_id
      )}&select=id,role,text,images,ts&order=ts.asc`;
      const r = await fetch(url, {
        headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      return ok({ messages: data });
    }

    if (event.httpMethod === "POST") {
      const { session_id, proof, timestamp, signature, role, text, images = [] } =
        JSON.parse(event.body || "{}");

      if (!session_id || !proof || !timestamp || !signature || !role || !text)
        return bad("missing_params");

      const secret_hash = await getSecretHash(session_id);
      if (!verify({ session_id, timestamp, bodyText: text, signature, secret_hash, proof }))
        return bad("invalid_signature", 401);

      const r = await fetch(MESSAGES, {
        method: "POST",
        headers: {
          apikey: SRK,
          Authorization: `Bearer ${SRK}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify([{ session_id, role, text, images }]),
      });
      if (!r.ok) throw new Error(await r.text());
      return ok({ ok: true });
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (e) {
    return bad(e.message, 500);
  }
}
