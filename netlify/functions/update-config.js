// يحفظ التعديل إلى GitHub بنفس أسلوب الأدمن القديم (Bearer <token>)
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false, message: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)/i);
  if (!m) return { statusCode: 401, body: JSON.stringify({ ok:false, message: 'Missing Bearer token' }) };
  const token = m[1].trim();

  // املأ المتغيرات من بيئة Netlify (لا تضع القيم في الكود)
  const owner  = process.env.GH_OWNER;   // مثال: "moustafaelsafy2-prog"
  const repo   = process.env.GH_REPO;    // مثال: "HEALTHAICOACH"
  const branch = process.env.GH_BRANCH || 'main';
  const path   = process.env.CONFIG_PATH || 'config.json';

  let newConfig;
  try { newConfig = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok:false, message:'Invalid JSON body' }) }; }

  // 1) احضر SHA الحالي للملف
  const fileApi = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const getRes = await fetch(fileApi, { headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }});
  if (getRes.status === 404) {
    // الملف غير موجود: سننشئه
  } else if (!getRes.ok) {
    const t = await getRes.text();
    return { statusCode: getRes.status, body: JSON.stringify({ ok:false, message: `GitHub GET failed: ${t}` }) };
  }

  let sha = null;
  if (getRes.ok) {
    const j = await getRes.json();
    sha = j.sha;
  }

  // 2) أنشئ/حدّث المحتوى
  const content = Buffer.from(JSON.stringify(newConfig, null, 2), 'utf8').toString('base64');
  const putRes = await fetch(fileApi, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'chore(admin): update config.json via dashboard',
      content,
      sha: sha || undefined,
      branch
    })
  });

  if (!putRes.ok) {
    const t = await putRes.text();
    return { statusCode: putRes.status, body: JSON.stringify({ ok:false, message: `GitHub PUT failed: ${t}` }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true })
  };
};
