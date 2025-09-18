exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false, error:'Method not allowed' }) };
  }
  const token = event.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ ok:false, error:'Unauthorized' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } 
  catch { return { statusCode: 400, body: JSON.stringify({ ok:false, error:'Invalid JSON' }) }; }
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'healthaicoach-config' });
  await store.setJSON('config.json', body);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok:true }),
  };
};
