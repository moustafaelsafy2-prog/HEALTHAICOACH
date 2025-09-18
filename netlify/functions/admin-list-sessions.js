/* Admin-only: list sessions summary */
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: 'ok' };

  const hdr = (event.headers || {});
  const key = hdr['x-admin-key'] || hdr['X-Admin-Key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return { statusCode: 401, headers: corsHeaders, body: 'Unauthorized' };
  }

  const { data, error } = await supabase
    .from('sessions_view') // تأكد تنفيذ الـ SQL لعمل الـ view
    .select('*')
    .order('last_message_at', { ascending: false })
    .limit(500);

  if (error) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data || []) };
};
