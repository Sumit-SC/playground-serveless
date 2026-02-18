/**
 * Multi-site headless scraper for mainstream job boards without public APIs.
 * Scrapes: Hirist, Naukri (India), and other JS-heavy portals.
 * 
 * Usage: /api/headless-scrape-multi?site=hirist|naukri|all&q=data+analyst
 * 
 * Note: Headless scraping is slow (~20-30s per site). Use sparingly.
 * Enable with ENABLE_HEADLESS=1 in Vercel env vars.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 30_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function enabled() {
	return String(process.env.ENABLE_HEADLESS || '').trim() === '1';
}

function defaultQuery(queryParam) {
	const q = (queryParam && String(queryParam).trim()) || 'data analyst';
	return q;
}

async function scrapeHirist(page, q) {
	// Focus on analyst roles - use query or default to analyst-focused terms
	const query = (q || 'data analyst').toLowerCase();
	const slug = query.replace(/\s+/g, '-');
	// Ensure we're searching for analyst roles, not just "data"
	const analystSlug = query.includes('analyst') ? slug : 'data-analyst';
	const url = 'https://hirist.com/jobs/' + analystSlug + '-jobs';
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
	await page.waitForSelector('.job-card, .job-item, [data-job-id], article, a[href*="/job/"]', { timeout: 12_000 }).catch(() => {});
	
	const jobs = await page.evaluate(() => {
		const out = [];
		const cards = document.querySelectorAll('.job-card, .job-item, [data-job-id], article.job, article[class*="job"]');
		if (cards.length === 0) {
			const links = document.querySelectorAll('a[href*="/job/"]');
			links.forEach((a) => {
				const title = (a.textContent || '').trim();
				if (title.length < 5) return;
				const href = a.getAttribute('href') || '';
				const url = href.startsWith('http') ? href : 'https://hirist.com' + href;
				const row = a.closest('tr, .row, li, div[class*="card"]');
				const companyEl = row ? row.querySelector('.company-name, .company, [class*="company"]') : null;
				out.push({ title, company: companyEl ? companyEl.textContent.trim() : 'Unknown', url, location: 'India' });
			});
			return out.slice(0, 50);
		}
		for (const card of cards) {
			const titleEl = card.querySelector('.job-title, h3, h2, h4, a[href*="/job/"]');
			const companyEl = card.querySelector('.company-name, .company, [class*="company"]');
			const linkEl = card.querySelector('a[href*="/job/"]');
			const anchor = linkEl || titleEl;
			if (!anchor) continue;
			const title = (titleEl ? titleEl.textContent : anchor.textContent || '').trim();
			if (!title || title.length < 3) continue;
			const href = anchor.getAttribute('href');
			const fullUrl = href && href.startsWith('http') ? href : 'https://hirist.com' + (href || '');
			out.push({
				title,
				company: companyEl ? companyEl.textContent.trim() : 'Unknown',
				url: fullUrl,
				location: 'India'
			});
			if (out.length >= 50) break;
		}
		return out;
	});
	
	return { source: 'hirist', jobs: jobs || [], url };
}

async function scrapeNaukri(page, q) {
	// Focus on analyst roles - prioritize analyst keywords
	const query = (q || 'data analyst').trim();
	const k = encodeURIComponent(query);
	// Use analyst-focused search URL
	const url = 'https://www.naukri.com/data-analyst-jobs?k=' + k + '&experience=2,3&l='; // 2-3 YOE filter
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
	await page.waitForSelector('.jobTupleHeader, .jobCard, [data-job-id], article, .list', { timeout: 12_000 }).catch(() => {});
	
	const jobs = await page.evaluate(() => {
		const out = [];
		const selectors = ['.jobTupleHeader', '.jobCard', 'article', '[data-job-id]', '.list .tuple'];
		let cards = [];
		for (const sel of selectors) {
			cards = document.querySelectorAll(sel);
			if (cards.length > 0) break;
		}
		for (const card of cards) {
			const titleEl = card.querySelector('.title a, .jobTitle a, a[href*="/job-listings/"], a[href*="/job/"]');
			if (!titleEl) continue;
			const title = titleEl.textContent.trim();
			if (!title || title.length < 3) continue;
			const href = titleEl.getAttribute('href');
			const fullUrl = href && href.startsWith('http') ? href : 'https://www.naukri.com' + (href || '');
			const companyEl = card.querySelector('.companyName, .company, [class*="companyName"]');
			const locEl = card.querySelector('.loc, .location, [class*="loc"]');
			out.push({
				title,
				company: companyEl ? companyEl.textContent.trim() : 'Unknown',
				url: fullUrl,
				location: locEl ? locEl.textContent.trim() : 'India'
			});
			if (out.length >= 50) break;
		}
		return out;
	});
	
	return { source: 'naukri', jobs: jobs || [], url };
}

async function scrapeAllSites(q) {
	const query = defaultQuery(q);
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
		await page.setUserAgent(USER_AGENT);
		
		// Scrape Hirist (mainstream India tech board)
		try {
			const hirist = await scrapeHirist(page, query);
			results.push(hirist);
		} catch (e) {
			results.push({ source: 'hirist', jobs: [], error: e.message });
		}
		
		// Scrape Naukri (mainstream India board)
		try {
			const naukri = await scrapeNaukri(page, query);
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
	const q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
	
	if (site === 'all') {
		const result = await scrapeAllSites(q);
		return res.status(200).json(result);
	}
	
	if (site === 'hirist' || site === 'naukri') {
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
			const result = site === 'hirist' ? await scrapeHirist(page, q) : await scrapeNaukri(page, q);
			return res.status(200).json({ ok: true, count: result.jobs.length, jobs: result.jobs, source: result.source, results: [result] });
		} catch (e) {
			return res.status(500).json({ ok: false, error: e.message });
		} finally {
			if (browser) try { await browser.close(); } catch (err) {}
		}
	}
	
	return res.status(200).json({
		ok: false,
		note: 'Use ?site=all or ?site=hirist or ?site=naukri. Optional: &q=data+analyst'
	});
};
