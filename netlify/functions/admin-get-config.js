export default async () => {
const { getStore } = await import('@netlify/blobs');
const store = getStore({ name: 'healthaicoach-config' });
const json = await store.get('config.json', { type: 'json' }) || {};
return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
};
