(async () => {
[img1,img2,img3].forEach(img => { if (img) img.src = cfg.avatar; });
}
} catch (e) { log('profile patch error', e); }


// 2) واتساب و«اتصال» في كل النوافذ
try {
if (cfg.whats) {
const href = `https://wa.me/${cfg.whats}`;
document.querySelectorAll('a[href^="https://wa.me/"]').forEach(a => a.href = href);
}
if (cfg.phone) {
const href = `tel:${cfg.phone}`;
document.querySelectorAll('a[href^="tel:"]').forEach(a => a.href = href);
const pp = document.getElementById('profilePhone');
if (pp) pp.textContent = cfg.phone.replace(/^\+/, '+');
}
} catch (e) { log('contact patch error', e); }


// 3) iHerb
try {
if (cfg.iherbCode) {
const codeEl = document.getElementById('iherb-code');
if (codeEl) codeEl.textContent = cfg.iherbCode;
}
if (cfg.iherbUrl || cfg.iherbCode) {
const btn = document.getElementById('copy-and-go-iherb-btn');
if (btn) {
const base = cfg.iherbUrl || btn.href;
const url = new URL(base, location.origin);
if (cfg.iherbCode) url.searchParams.set('rcode', cfg.iherbCode);
btn.href = url.toString();
}
}
} catch (e) { log('iherb patch error', e); }


// 4) عناوين الترحيب
try {
if (cfg.welcomeTitle) { const el = document.getElementById('welcomeTitle'); if (el) el.textContent = cfg.welcomeTitle; }
if (cfg.welcomeSubtitle) { const el = document.getElementById('welcomeSubtitle'); if (el) el.textContent = cfg.welcomeSubtitle; }
} catch (e) { log('welcome patch error', e); }


// 5) توجيه الذكاء الاصطناعي — Patch
try {
if (cfg.aiPrompt && window.App && App.prompts && typeof App.prompts.buildCoachSystemPrompt === 'function') {
App.prompts.buildCoachSystemPrompt = function(){ return cfg.aiPrompt; };
log('AI system prompt patched.');
}
} catch (e) { log('ai prompt patch error', e); }


log('Runtime patch applied.', cfg);
})();
