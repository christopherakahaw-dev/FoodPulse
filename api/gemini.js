// Vercel serverless function: forwards Food Pulse's Gemini requests so the
// API key stays on the server. Configure in Vercel → Settings → Environment Variables:
//   GEMINI_API_KEY  (required)  your key from https://aistudio.google.com/apikey
//   GEMINI_MODEL    (optional)  e.g. gemini-flash-latest; picked automatically if unset
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const PREFS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
let cachedModel = null;

async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (cachedModel) return cachedModel;
  const r = await fetch(API + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error((j && j.error && j.error.message) || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
  const names = ((j && j.models) || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
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
    let r = await send(model);
    if (r.status === 404 && !process.env.GEMINI_MODEL) { cachedModel = null; model = await pickModel(key); r = await send(model); }
    const j = await r.json().catch(() => ({ error: { message: 'Gemini sent an unreadable answer' } }));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(e.status || 502).json(e.body || { error: { message: e.message || 'Couldn’t reach Gemini' } });
  }
};
