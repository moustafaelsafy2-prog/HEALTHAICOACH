/* Admin-only: get messages by session_id */
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

  const session_id = (event.queryStringParameters || {}).session_id;
  if (!session_id) {
    return { statusCode: 400, headers: corsHeaders, body: 'Missing session_id' };
  }

  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, images, created_at')
    .eq('session_id', session_id)
    .order('id', { ascending: true });

  if (error) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data || []) };
};
