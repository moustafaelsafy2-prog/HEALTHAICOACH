const { getClient } = require('./_shared/supabase');

exports.handler = async () => {
  try {
    const supabase = await getClient();
    const { count, error } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, messages_count: count }),
    };
  } catch (e) {
    return { statusCode: 500, body: e.message || 'Server error' };
  }
};
