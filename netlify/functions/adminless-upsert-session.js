const { getClient } = require('./_shared/supabase');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { session_id } = JSON.parse(event.body || '{}');
    if (!session_id) return { statusCode: 400, body: 'session_id required' };

    const supabase = await getClient();

    const { error } = await supabase
      .from('sessions')
      .insert({ id: session_id })
      .onConflict('id')
      .ignore();

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, session_id }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || 'Server error' };
  }
};
