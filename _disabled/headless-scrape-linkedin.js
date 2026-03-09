/**
 * Headless scraper for LinkedIn Jobs (mainstream job board).
 * LinkedIn has no public job-search API; this scrapes search results when enabled.
 *
 * Usage: /api/headless-scrape-linkedin?q=data+analyst&location=remote&experience=2,3
 *
 * Note: LinkedIn actively blocks/throttles bots and may require login. Use VERY sparingly.
 * Enable with ENABLE_HEADLESS=1. LinkedIn ToS prohibits scraping - use at your own risk.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 30_000;
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
	const location = (req.query && req.query.location) ? String(req.query.location).trim() : 'remote';
	const experience = (req.query && req.query.experience) ? String(req.query.experience).trim() : '2,3'; // 2-3 YOE
	
	// LinkedIn job search URL (public, no login required for basic search)
	const base = 'https://www.linkedin.com/jobs/search';
	const params = new URLSearchParams({
		keywords: q,
		location: location,
		f_TPR: 'r86400', // Last 24 hours
		f_E: experience, // Experience level filter
		f_TP: '1', // Full-time
		start: '0'
	});
	const url = base + '?' + params.toString();

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
		
		// Wait for job listings to load
		await page.waitForSelector('.jobs-search__results-list, ul.jobs-search__results-list, [data-test-id="job-card"]', { timeout: 15_000 }).catch(() => {});

		const jobs = await page.evaluate((siteUrl) => {
			const out = [];
			const container = document.querySelector('.jobs-search__results-list') || document.querySelector('ul[class*="results"]') || document.body;
			const cards = container.querySelectorAll('li[class*="job"], [data-test-id="job-card"], .job-card-container');
			
			for (const card of cards) {
				const link = card.querySelector('a[href*="/jobs/view/"], a[href*="/jobs/"]');
				if (!link) continue;
				
				const title = (link.textContent || link.getAttribute('aria-label') || '').trim();
				if (!title || title.length < 3) continue;
				
				let href = link.getAttribute('href') || '';
				if (href.startsWith('/')) href = 'https://www.linkedin.com' + href;
				
				const companyEl = card.querySelector('.job-search-card__subtitle, .base-search-card__subtitle, [class*="company"]');
				const locationEl = card.querySelector('.job-search-card__location, .base-search-card__metadata, [class*="location"]');
				const timeEl = card.querySelector('.job-search-card__listdate, [class*="time"], time');
				
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locationEl ? locationEl.textContent.trim() : '',
					url: href,
					date: timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : ''
				});
				
				if (out.length >= 30) break; // Limit to avoid detection
			}
			return out;
		}, url);

		return res.status(200).json({
			ok: true,
			count: jobs.length,
			jobs,
			source: 'linkedin_headless',
			url,
			warning: 'LinkedIn may block/throttle scrapers. Use sparingly.'
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'LinkedIn scrape failed (may be blocked)',
			message: (e && e.message) ? e.message : String(e),
			note: 'LinkedIn actively blocks bots. This endpoint may not work reliably.'
		});
	} finally {
		if (browser) {
			try { await browser.close(); } catch (err) {}
		}
	}
};
