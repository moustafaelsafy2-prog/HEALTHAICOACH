const { getClient } = require('./_shared/supabase');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const payload = JSON.parse(event.body || '{}');
    const { session_id, role, text } = payload;
    const images = Array.isArray(payload.images) ? payload.images : [];

    if (!session_id || !role || typeof text !== 'string') {
      return {
        statusCode: 400,
        body: 'session_id, role, text are required',
      };
    }

    const supabase = await getClient();

    // تأكد أن الجلسة موجودة (idempotent)
    await supabase.from('sessions').insert({ id: session_id }).onConflict('id').ignore();

    // أدخل الرسالة
    const { data, error } = await supabase
      .from('messages')
      .insert({
        session_id,
        role,
        text,
        images,       // jsonb[]
        ts: Date.now() // bigint (ms)
      })
      .select()
      .single();

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, message: data }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || 'Server error' };
  }
};
