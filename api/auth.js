/**
 * Check UI secret so the test UI can be protected. Set env UI_SECRET.
 * GET /api/auth?secret=xxx or header X-UI-Secret: xxx
 */
module.exports = async function handler(req, res) {
	if (req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'X-UI-Secret, Content-Type');
		return res.status(204).end();
	}
	if (req.method !== 'GET') {
		return res.status(405).json({ ok: false, error: 'Method not allowed' });
	}
	var expected = process.env.UI_SECRET || '';
	var provided = (req.query && req.query.secret) ? String(req.query.secret).trim() : (req.headers['x-ui-secret'] || '').trim();
	if (!expected || provided !== expected) {
		return res.status(401).json({ ok: false, error: 'Invalid or missing secret' });
	}
	res.setHeader('Access-Control-Allow-Origin', '*');
	return res.status(200).json({ ok: true });
}
