/**
 * Working Nomads exposed jobs proxy (CORS-friendly).
 * Source API: https://www.workingnomads.com/api/exposed_jobs/
 *
 * Usage:
 *   /api/workingnomads?q=data%20science&count=50
 */

const DEFAULT_COUNT = 50;
const MAX_COUNT = 100;
const TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: 'GET',
			headers: {
				'User-Agent': 'sumit-personal-site workingnomads proxy',
				'Accept': 'application/json, */*'
			},
			signal: ctrl.signal
		});
	} finally {
		clearTimeout(t);
	}
}

function safeText(x) {
	return (x == null) ? '' : String(x);
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600'); // 30m

	if (req.method === 'OPTIONS') return res.status(200).end();

	const q = (req.query && req.query.q) ? String(req.query.q).trim().toLowerCase() : '';
	let count = DEFAULT_COUNT;
	if (req.query && req.query.count != null) {
		const n = parseInt(String(req.query.count), 10);
		if (!isNaN(n)) count = Math.max(1, Math.min(MAX_COUNT, n));
	}

	try {
		const r = await fetchWithTimeout('https://www.workingnomads.com/api/exposed_jobs/');
		if (!r.ok) return res.status(502).json({ ok: false, error: 'Fetch failed', status: r.status });
		const data = await r.json();
		const items = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);

		let out = items.map((it) => ({
			id: it.id || it.slug || it.url || Math.random().toString(36).slice(2),
			title: safeText(it.title || it.position || it.job_title),
			company: safeText(it.company || it.company_name),
			location: safeText(it.location || it.region || it.country || 'Remote'),
			url: safeText(it.url || it.apply_url || it.link),
			description: safeText(it.description || it.snippet || it.summary || ''),
			date: safeText(it.date || it.created_at || it.publication_date || it.published_at || '')
		}));

		if (q) {
			out = out.filter((j) => {
				const text = (j.title + ' ' + j.company + ' ' + j.location + ' ' + j.description).toLowerCase();
				return text.includes(q);
			});
		}

		out = out.slice(0, count);
		return res.status(200).json({ ok: true, count: out.length, jobs: out });
	} catch (e) {
		return res.status(500).json({ ok: false, error: 'Failed to fetch Working Nomads', message: e && e.message ? e.message : String(e) });
	}
};

