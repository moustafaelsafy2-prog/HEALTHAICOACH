// ESM-friendly supabase client for CommonJS Netlify Functions.
// نستخدم dynamic import لأن @supabase/supabase-js (v2) ESM فقط.
let cached = null;

async function getClient() {
  if (cached) return cached;

  const { createClient } = await import('@supabase/supabase-js'); // <-- ESM
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL; // احتياطي لو كنت تستخدم متغير عام
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE; // اسم بديل لو استخدمته

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

module.exports = { getClient };
