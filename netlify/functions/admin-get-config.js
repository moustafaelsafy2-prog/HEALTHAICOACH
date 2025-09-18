exports.handler = async () => {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'healthaicoach-config' });
  const json = await store.get('config.json', { type: 'json' }) || {};
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(json),
  };
};
