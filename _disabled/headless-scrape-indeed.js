/**
 * Headless scraper for Indeed (mainstream job board).
 * Indeed has no public job-search API; this scrapes search results when enabled.
 *
 * Usage: /api/headless-scrape-indeed?q=data+analyst&l=remote
 *
 * Note: Indeed may block or throttle bots. Use sparingly. Enable with ENABLE_HEADLESS=1.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 25_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function enabled() {
	return String(process.env.ENABLE_HEADLESS || '').trim() === '1';
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
	if (req.method === 'OPTIONS') return res.status(200).end();

	if (!enabled()) {
		return res.status(200).json({
			ok: false,
			count: 0,
			jobs: [],
			note: 'Headless scraping disabled. Set ENABLE_HEADLESS=1 to enable.'
		});
	}

	const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
	const loc = (req.query && req.query.l) ? String(req.query.l).trim() : 'remote';
	const base = 'https://www.indeed.com/jobs';
	const url = base + '?q=' + encodeURIComponent(q) + '&l=' + encodeURIComponent(loc);

	let browser;
	try {
		browser = await puppeteer.launch({
			args: chromium.args,
			defaultViewport: chromium.defaultViewport,
			executablePath: await chromium.executablePath(),
			headless: chromium.headless
		});

		const page = await browser.newPage();
		page.setDefaultNavigationTimeout(TIMEOUT_MS);
		await page.setUserAgent(USER_AGENT);

		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('#mosaic-jobResults, [data-job-key], .job_seen_beacon, .jobsearch-ResultsList li', { timeout: 12_000 }).catch(() => {});

		const jobs = await page.evaluate((siteUrl) => {
			const out = [];
			const container = document.querySelector('#mosaic-jobResults') || document.querySelector('.jobsearch-ResultsList') || document.body;
			const cards = container.querySelectorAll('[data-job-key], .job_seen_beacon, li[class*="job"]');
			const linkSel = 'a[href*="/rc/clk?"], a[href*="/viewjob?"], a[href*="/job/"]';
			for (const card of cards) {
				const link = card.querySelector(linkSel);
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title || title.length < 3) continue;
				let href = link.getAttribute('href') || '';
				if (href.startsWith('/')) href = 'https://www.indeed.com' + href;
				const companyEl = card.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
				const locEl = card.querySelector('[data-testid="text-location"], .companyLocation, [class*="location"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : siteUrl.includes('l=remote') ? 'Remote' : '',
					url: href
				});
				if (out.length >= 40) break;
			}
			return out;
		}, url);

		return res.status(200).json({
			ok: true,
			count: jobs.length,
			jobs,
			source: 'indeed_headless',
			url
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'Headless scrape failed',
			message: (e && e.message) ? e.message : String(e)
		});
	} finally {
		if (browser) {
			try { await browser.close(); } catch (err) {}
		}
	}
};
