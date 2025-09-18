export default async (req) => {
if (req.method !== 'POST') {
return new Response(JSON.stringify({ ok:false, error:'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}
const token = req.headers.get('x-admin-token');
if (!token || token !== process.env.ADMIN_TOKEN) {
return new Response(JSON.stringify({ ok:false, error:'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}
const body = await req.json().catch(()=>null);
if (!body) {
return new Response(JSON.stringify({ ok:false, error:'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}
const { getStore } = await import('@netlify/blobs');
const store = getStore({ name: 'healthaicoach-config' });
await store.setJSON('config.json', body);
return new Response(JSON.stringify({ ok:true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
};
