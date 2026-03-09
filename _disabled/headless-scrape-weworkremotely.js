/**
 * OPTIONAL headless scraper example (disabled by default).
 *
 * Why optional: headless Chromium on serverless can be slow/cold-starty.
 * Enable only when needed by setting env ENABLE_HEADLESS=1 on Vercel.
 *
 * This scraper loads WeWorkRemotely's "remote data jobs" page and extracts basic cards.
 * (WWR already has RSS feeds — this is mostly a template for other JS-heavy sources.)
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 25_000;

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

	const url = 'https://weworkremotely.com/remote-data-jobs';
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
		await page.goto(url, { waitUntil: 'domcontentloaded' });

		const jobs = await page.evaluate(() => {
			// WWR pages typically contain: section.jobs > article > ul > li
			const out = [];
			const links = Array.from(document.querySelectorAll('a[href*="/remote-jobs/"]'));
			for (const a of links) {
				const title = (a.textContent || '').trim();
				if (!title || title.length < 6) continue;
				const href = a.getAttribute('href') || '';
				if (!href.startsWith('/remote-jobs/')) continue;
				out.push({ title, url: 'https://weworkremotely.com' + href });
				if (out.length >= 60) break;
			}
			return out;
		});

		return res.status(200).json({
			ok: true,
			count: jobs.length,
			jobs,
			source: 'weworkremotely_headless',
			url
		});
	} catch (e) {
		return res.status(500).json({ ok: false, error: 'Headless scrape failed', message: e && e.message ? e.message : String(e) });
	} finally {
		if (browser) {
			try { await browser.close(); } catch (e) {}
		}
	}
};

