const { getClient } = require('./_shared/supabase');

exports.handler = async (event) => {
  try {
    const session_id = (event.queryStringParameters || {}).session_id;
    if (!session_id) return { statusCode: 400, body: 'session_id required' };

    const supabase = await getClient();

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', session_id)
      .order('ts', { ascending: true })
      .limit(1000);

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, messages: data }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || 'Server error' };
  }
};
