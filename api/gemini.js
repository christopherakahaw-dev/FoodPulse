// Vercel serverless function: forwards Food Pulse's Gemini requests so the
// API key stays on the server. Configure in Vercel → Settings → Environment Variables:
//   GEMINI_API_KEY  (required)  your key from https://aistudio.google.com/apikey
//   GEMINI_MODEL    (optional)  e.g. gemini-flash-latest; picked automatically if unset
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const PREFS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
let cachedModel = null, cachedNames = [];
// Google returns these when a model is overloaded ("high demand"); worth retrying or switching model.
const BUSY = new Set([429, 500, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Models that just answered "busy" are skipped for a minute (per warm function instance).
const busyUntil = {};
const isBusy = m => (busyUntil[m] || 0) > Date.now();

async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (cachedModel) return cachedModel;
  const r = await fetch(API + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error((j && j.error && j.error.message) || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
  const names = cachedNames = ((j && j.models) || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
  cachedModel = PREFS.find(n => names.includes(n)) ||
    names.find(n => /flash/.test(n) && !/image|tts|live|audio|embed|preview|exp/.test(n)) ||
    names.find(n => /gemini/.test(n) && !/image|tts|live|audio|embed/.test(n)) || names[0];
  return cachedModel;
}

function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.GEMINI_API_KEY;
  if (req.method === 'GET') {
    if (!key) return res.status(200).json({ configured: false });
    try { return res.status(200).json({ configured: true, model: await pickModel(key) }); }
    catch (e) { return res.status(200).json({ configured: true, model: null, error: e.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!sameSite(req)) return res.status(403).json({ error: { message: 'Requests are only accepted from this site.' } });
  if (!key) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not set on the server.', status: 'NOT_CONFIGURED' } });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.contents)) return res.status(400).json({ error: { message: 'Bad request' } });

  try {
    let model = await pickModel(key);
    const send = m => fetch(API + 'models/' + encodeURIComponent(m) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: body.contents, generationConfig: body.generationConfig || {} })
    });
    const others = () => PREFS.filter(n => n !== model && (cachedNames.length ? cachedNames.includes(n) : true)).reverse();
    let r = null;
    if (!isBusy(model)) {
      r = await send(model);
      if (r.status === 404 && !process.env.GEMINI_MODEL) { cachedModel = null; model = await pickModel(key); r = await send(model); }
      if (BUSY.has(r.status)) { await sleep(700); r = await send(model); }
      if (BUSY.has(r.status)) busyUntil[model] = Date.now() + 60000;
    }
    // Busy: try other models this key can use, lightest first, within the function's time budget.
    const started = Date.now();
    for (const alt of others()) {
      if ((r && !BUSY.has(r.status)) || Date.now() - started > 15000) break;
      if (isBusy(alt)) continue;
      const r2 = await send(alt);
      if (r2.status === 404) continue;
      if (BUSY.has(r2.status)) busyUntil[alt] = Date.now() + 60000;
      r = r2;
    }
    if (!r) { busyUntil[model] = 0; r = await send(model); }
    const j = await r.json().catch(() => ({ error: { message: 'Gemini sent an unreadable answer' } }));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(e.status || 502).json(e.body || { error: { message: e.message || 'Couldn’t reach Gemini' } });
  }
};
