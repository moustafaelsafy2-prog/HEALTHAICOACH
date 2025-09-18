/* Adminless: add chat message (user/assistant) */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: 'ok' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }

  const session_id = body.session_id;
  if (!session_id) {
    return { statusCode: 400, headers: corsHeaders, body: 'Missing session_id' };
  }

  const role = body.role === 'assistant' ? 'assistant' : 'user';
  const text = (body.text || '').toString();
  const images = Array.isArray(body.images) ? body.images.slice(0, 5) : [];
  // ts اختياري – لو حاب تخزّنه كعمود إضافي لاحقًا

  // تأكد أن الجلسة موجودة (بدون تعديل لو موجودة)
  const { error: sErr } = await supabase
    .from('sessions')
    .upsert({ session_id }, { onConflict: 'session_id' });
  if (sErr) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: sErr.message }) };
  }

  const { data, error } = await supabase
    .from('messages')
    .insert({ session_id, role, content: text, images })
    .select('id')
    .single();

  if (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, id: data.id }) };
};
