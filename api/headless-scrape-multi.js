/**
 * Multi-site headless scraper for job boards without APIs/RSS.
 * Scrapes: Hirist, Naukri (India-focused), and other JS-heavy sites.
 * 
 * Usage: /api/headless-scrape-multi?site=hirist|naukri|all
 * 
 * Note: Headless scraping is slow (~20-30s per site). Use sparingly.
 * Enable with ENABLE_HEADLESS=1 in Vercel env vars.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 30_000;

function enabled() {
	return String(process.env.ENABLE_HEADLESS || '').trim() === '1';
}

async function scrapeHirist(page) {
	const url = 'https://hirist.com/jobs/data-analyst-jobs';
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
	
	const jobs = await page.evaluate(() => {
		const out = [];
		// Hirist job cards typically in .job-card or similar
		const cards = document.querySelectorAll('.job-card, .job-item, [data-job-id]');
		for (const card of cards) {
			const titleEl = card.querySelector('.job-title, h3, h2, a[href*="/job/"]');
			const companyEl = card.querySelector('.company-name, .company');
			const linkEl = card.querySelector('a[href*="/job/"]');
			if (!titleEl || !linkEl) continue;
			const title = titleEl.textContent.trim();
			const company = companyEl ? companyEl.textContent.trim() : 'Unknown';
			const href = linkEl.getAttribute('href');
			const url = href.startsWith('http') ? href : 'https://hirist.com' + href;
			out.push({ title, company, url, location: 'India' });
			if (out.length >= 50) break;
		}
		return out;
	});
	
	return { source: 'hirist', jobs, url };
}

async function scrapeNaukri(page) {
	const url = 'https://www.naukri.com/data-analyst-jobs?k=data%20analyst&l=remote';
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
	
	// Wait for job cards to load
	await page.waitForSelector('.jobTupleHeader, .jobCard, [data-job-id]', { timeout: 10_000 }).catch(() => {});
	
	const jobs = await page.evaluate(() => {
		const out = [];
		const cards = document.querySelectorAll('.jobTupleHeader, .jobCard, [data-job-id]');
		for (const card of cards) {
			const titleEl = card.querySelector('.title a, .jobTitle a, a[href*="/job/"]');
			const companyEl = card.querySelector('.companyName, .company');
			if (!titleEl) continue;
			const title = titleEl.textContent.trim();
			const company = companyEl ? companyEl.textContent.trim() : 'Unknown';
			const href = titleEl.getAttribute('href');
			const url = href && href.startsWith('http') ? href : 'https://www.naukri.com' + (href || '');
			const locEl = card.querySelector('.loc, .location');
			const location = locEl ? locEl.textContent.trim() : 'India';
			out.push({ title, company, url, location });
			if (out.length >= 50) break;
		}
		return out;
	});
	
	return { source: 'naukri', jobs, url };
}

async function scrapeAllSites() {
	const results = [];
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
		
		// Scrape Hirist
		try {
			const hirist = await scrapeHirist(page);
			results.push(hirist);
		} catch (e) {
			results.push({ source: 'hirist', jobs: [], error: e.message });
		}
		
		// Scrape Naukri
		try {
			const naukri = await scrapeNaukri(page);
			results.push(naukri);
		} catch (e) {
			results.push({ source: 'naukri', jobs: [], error: e.message });
		}
		
	} catch (e) {
		return { ok: false, error: 'Headless scrape failed', message: e.message };
	} finally {
		if (browser) {
			try { await browser.close(); } catch (e) {}
		}
	}
	
	const allJobs = [];
	results.forEach((r) => {
		if (r.jobs && Array.isArray(r.jobs)) {
			r.jobs.forEach((j) => {
				allJobs.push({ ...j, source: r.source });
			});
		}
	});
	
	return {
		ok: true,
		count: allJobs.length,
		sources: results.map(r => r.source),
		jobs: allJobs,
		results
	};
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	if (!enabled()) {
		return res.status(200).json({
			ok: false,
			count: 0,
			jobs: [],
			note: 'Headless scraping disabled. Set ENABLE_HEADLESS=1 to enable.'
		});
	}
	
	const site = (req.query && req.query.site) ? String(req.query.site).toLowerCase() : 'all';
	
	if (site === 'all') {
		const result = await scrapeAllSites();
		return res.status(200).json(result);
	}
	
	// Single site scraping (future: add ?site=hirist or ?site=naukri)
	return res.status(200).json({
		ok: false,
		note: 'Use ?site=all to scrape all sites, or implement single-site scraping'
	});
};
