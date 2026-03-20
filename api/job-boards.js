/**
 * Lightweight "job boards directory" endpoint.
 *
 * Why: Many boards block scraping and don't provide RSS/JSON. This endpoint returns
 * deep-links that always work, so the UI can open searches on those boards.
 *
 * Usage:
 *   GET /api/job-boards?q=data%20analyst&location=remote%20india
 */
function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function safeStr(v, fallback) {
	const s = (v == null ? '' : String(v)).trim();
	return s || fallback || '';
}

function enc(v) {
	return encodeURIComponent(String(v || '').trim());
}

function buildBoards(q, location) {
	const query = safeStr(q, 'data analyst');
	const loc = safeStr(location, 'remote');

	// Some boards don't support location filters via URL; keep it in the query for best results.
	const qWithLoc = loc ? (query + ' ' + loc) : query;

	return [
		{
			id: 'hireflair',
			name: 'Hireflair',
			type: 'board',
			// No stable public search URL format found; link to homepage.
			url: 'https://hireflair.com/'
		},
		{
			id: 'cutshort',
			name: 'Cutshort (India)',
			type: 'board',
			url: 'https://cutshort.io/jobs?query=' + enc(query)
		},
		{
			id: 'foundit',
			name: 'foundit (Monster India)',
			type: 'board',
			url: 'https://www.foundit.in/srp/results?query=' + enc(query)
		},
		{
			id: 'hirist_loc',
			name: 'Hirist (query + location)',
			type: 'board',
			url: 'https://www.hirist.com/search/?q=' + enc(qWithLoc)
		},
		{
			id: 'ycombinator_jobs',
			name: 'Y Combinator · Jobs',
			type: 'board',
			url: 'https://www.ycombinator.com/jobs?query=' + enc(query)
		},
		{
			id: 'workatastartup',
			name: 'Work at a Startup',
			type: 'board',
			url: 'https://www.workatastartup.com/jobs?query=' + enc(query)
		},
		{
			id: 'instahyre',
			name: 'Instahyre',
			type: 'board',
			url: 'https://www.instahyre.com/search/?q=' + enc(query)
		},
		{
			id: 'hirist',
			name: 'Hirist (India)',
			type: 'board',
			url: 'https://www.hirist.com/search/?q=' + enc(query)
		},
		{
			id: 'naukri',
			name: 'Naukri (India)',
			type: 'board',
			url: 'https://www.naukri.com/' + enc(query.replace(/\s+/g, '-')) + '-jobs'
		},
		{
			id: 'timesjobs',
			name: 'TimesJobs (India)',
			type: 'board',
			url: 'https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=' + enc(query)
		},
		{
			id: 'shine',
			name: 'Shine (India)',
			type: 'board',
			url: 'https://www.shine.com/job-search/' + enc(query.replace(/\s+/g, '-')) + '-jobs'
		},
		{
			id: 'hiring_cafe',
			name: 'hiring.cafe',
			type: 'board',
			url: 'https://hiring.cafe/?search=' + enc(query)
		},
		{
			id: 'xing',
			name: 'Xing Jobs',
			type: 'board',
			url: 'https://www.xing.com/jobs/search?keywords=' + enc(query)
		},
		{
			id: 'wellfound',
			name: 'Wellfound (AngelList)',
			type: 'board',
			url: 'https://wellfound.com/jobs?keywords=' + enc(query)
		},
		{
			id: 'greenhouse_all',
			name: 'Greenhouse (all jobs)',
			type: 'board',
			url: 'https://www.google.com/search?q=' + enc('site:boards.greenhouse.io ' + qWithLoc)
		},
		{
			id: 'lever_all',
			name: 'Lever (all jobs)',
			type: 'board',
			url: 'https://www.google.com/search?q=' + enc('site:jobs.lever.co ' + qWithLoc)
		},
		{
			id: 'linkedin',
			name: 'LinkedIn',
			type: 'board',
			url: 'https://www.linkedin.com/jobs/search/?keywords=' + enc(query) + '&location=' + enc(loc || 'Remote')
		},
		{
			id: 'indeed',
			name: 'Indeed',
			type: 'board',
			url: 'https://www.indeed.com/jobs?q=' + enc(query) + '&l=' + enc(loc || 'remote')
		},
		{
			id: 'instahyre_loc',
			name: 'Instahyre (query + location)',
			type: 'board',
			url: 'https://www.instahyre.com/search/?q=' + enc(qWithLoc)
		}
	];
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400'); // 1h
	if (req.method === 'OPTIONS') return res.status(200).end();

	const q = safeStr(req.query && req.query.q, 'data analyst');
	const location = safeStr(req.query && req.query.location, 'remote');
	const limit = clamp(parseInt(String((req.query && req.query.limit) || '30'), 10) || 30, 1, 60);

	const boards = buildBoards(q, location).slice(0, limit);

	return res.status(200).json({
		ok: true,
		q,
		location,
		count: boards.length,
		boards
	});
};

