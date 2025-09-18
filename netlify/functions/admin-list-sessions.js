const { getClient } = require('./_shared/supabase');

exports.handler = async () => {
  try {
    const supabase = await getClient();

    // يقرأ من الـ VIEW المقترح: sessions_summary
    const { data, error } = await supabase
      .from('sessions_summary')
      .select('*')
      .order('last_ts', { ascending: false })
      .limit(200);

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, sessions: data }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || 'Server error' };
  }
};
