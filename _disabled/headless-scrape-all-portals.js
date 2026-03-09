/**
 * Unified headless scraper for all major job portals.
 * Scrapes: LinkedIn, Naukri, Indeed, Monster, Foundit, Glassdoor, Hirist, JobsAaj,
 *         TimesJobs, Shine, ZipRecruiter, SimplyHired, CareerBuilder, Dice, Adzuna, Jooble, Freshersworld,
 *         RemoteOK, Remotive, WeWorkRemotely, WorkingNomads, Wellfound, Remote.co, Jobspresso, Himalayas, Authentic Jobs
 * 
 * Usage: /api/headless-scrape-all-portals?q=data+analyst&days=3&location=remote
 * 
 * This endpoint:
 * 1. Scrapes all portals in parallel (with timeouts)
 * 2. Filters by date (last N days), location (remote first), work type
 * 3. Stores results in Vercel KV
 * 4. Returns aggregated results
 * 
 * Enable with ENABLE_HEADLESS=1 in Vercel env vars.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TIMEOUT_MS = 30_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CACHE_KEY = 'jobs:scraped:all-portals';
const CACHE_TTL = 3600; // 1 hour

function enabled() {
	return String(process.env.ENABLE_HEADLESS || '').trim() === '1';
}

function hasKv() {
	return process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
}

function parseDate(dateStr) {
	if (!dateStr) return null;
	const d = new Date(dateStr);
	if (!isNaN(d.getTime())) return d;
	// Try parsing relative dates
	const rel = String(dateStr).toLowerCase();
	if (rel.includes('today') || rel.includes('just now')) return new Date();
	if (rel.includes('yesterday')) return new Date(Date.now() - 24 * 60 * 60 * 1000);
	const daysMatch = rel.match(/(\d+)\s*(?:day|days)/);
	if (daysMatch) {
		const days = parseInt(daysMatch[1], 10);
		return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	}
	return null;
}

function filterByDate(jobs, maxDays) {
	if (!maxDays) return jobs;
	const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
	return jobs.filter(job => {
		const date = parseDate(job.date || job.postedDate);
		if (!date) return true; // Keep if no date
		return date.getTime() >= cutoff;
	});
}

function sortByLocation(jobs) {
	return jobs.sort((a, b) => {
		const locA = String(a.location || '').toLowerCase();
		const locB = String(b.location || '').toLowerCase();
		const remoteA = /remote|work from home|wfh|anywhere|distributed/.test(locA);
		const remoteB = /remote|work from home|wfh|anywhere|distributed/.test(locB);
		if (remoteA && !remoteB) return -1;
		if (!remoteA && remoteB) return 1;
		return 0;
	});
}

function dedupeByUrl(jobs) {
	const seen = new Set();
	return jobs.filter((j) => {
		const u = String(j && j.url ? j.url : '').trim();
		if (!u) return false;
		if (seen.has(u)) return false;
		seen.add(u);
		return true;
	});
}

async function fetchText(url, timeoutMs) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
		});
		if (!r.ok) return '';
		return await r.text();
	} catch (e) {
		return '';
	} finally {
		clearTimeout(t);
	}
}

async function fetchJson(url, timeoutMs) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
		});
		if (!r.ok) return null;
		return await r.json();
	} catch (e) {
		return null;
	} finally {
		clearTimeout(t);
	}
}

function stripHtml(s) {
	return String(s || '')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractFirst(haystack, re) {
	const m = String(haystack || '').match(re);
	return m ? (m[1] || '').trim() : '';
}

// Individual portal scrapers
async function scrapeLinkedIn(page, q, location, experience) {
	try {
		const base = 'https://www.linkedin.com/jobs/search';
		const params = new URLSearchParams({
			keywords: q,
			location: location || 'remote',
			f_TPR: 'r259200', // Last 3 days
			f_E: experience || '2,3',
			f_TP: '1', // Full-time
			start: '0'
		});
		const url = base + '?' + params.toString();
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.jobs-search__results-list, [data-test-id="job-card"]', { timeout: 15_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('li[class*="job"], [data-test-id="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/jobs/view/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.linkedin.com' + href : href;
				const companyEl = card.querySelector('.job-search-card__subtitle, [class*="company"]');
				const locationEl = card.querySelector('.job-search-card__location, [class*="location"]');
				const timeEl = card.querySelector('.job-search-card__listdate, time');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locationEl ? locationEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '',
					source: 'linkedin'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'linkedin', jobs, url };
	} catch (e) {
		return { source: 'linkedin', jobs: [], error: e.message };
	}
}

// Remote hiring platforms (non-headless / lightweight where possible)
async function fetchRemoteOk(q) {
	const url = 'https://remoteok.com/api';
	try {
		const data = await fetchJson(url, 12_000);
		const list = Array.isArray(data) ? data : (data && Array.isArray(data.jobs) ? data.jobs : []);
		const query = String(q || '').toLowerCase();
		const jobs = [];
		for (const it of list) {
			if (!it || !it.position || !it.url) continue;
			const title = String(it.position).trim();
			const full = (title + ' ' + stripHtml(it.description || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : '')).toLowerCase();
			if (query && !full.includes(query) && !title.toLowerCase().includes(query)) continue;
			jobs.push({
				title,
				company: it.company || 'Unknown',
				location: it.location || 'Remote',
				url: String(it.url).startsWith('http') ? it.url : ('https://remoteok.com' + it.url),
				date: it.date || '',
				source: 'remoteok'
			});
			if (jobs.length >= 60) break;
		}
		return { source: 'remoteok', jobs, url };
	} catch (e) {
		return { source: 'remoteok', jobs: [], error: e.message, url };
	}
}

async function fetchRemotive(q) {
	const url = 'https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(q || 'data analyst');
	try {
		const data = await fetchJson(url, 12_000);
		const list = data && (data.jobs || data['remote-jobs'] || data.results);
		const jobs = [];
		if (Array.isArray(list)) {
			for (const it of list) {
				if (!it || !it.title || !it.url) continue;
				jobs.push({
					title: it.title,
					company: it.company_name || 'Unknown',
					location: it.candidate_required_location || it.location || 'Remote',
					url: it.url,
					date: it.publication_date || it.created_at || '',
					source: 'remotive'
				});
				if (jobs.length >= 60) break;
			}
		}
		return { source: 'remotive', jobs, url };
	} catch (e) {
		return { source: 'remotive', jobs: [], error: e.message, url };
	}
}

async function fetchWorkingNomads(baseUrl, q) {
	const url = baseUrl ? (baseUrl.replace(/\/$/, '') + '/api/workingnomads?q=' + encodeURIComponent(q || 'data analyst') + '&count=80') : '';
	try {
		if (!url) return { source: 'workingnomads', jobs: [], error: 'missing_base_url' };
		const data = await fetchJson(url, 15_000);
		const list = data && data.ok && Array.isArray(data.jobs) ? data.jobs : [];
		const jobs = list.slice(0, 80).map((it) => ({
			title: it.title,
			company: it.company || 'Unknown',
			location: it.location || 'Remote',
			url: it.url,
			date: it.date || '',
			source: 'workingnomads'
		}));
		return { source: 'workingnomads', jobs, url };
	} catch (e) {
		return { source: 'workingnomads', jobs: [], error: e.message, url };
	}
}

async function fetchWeWorkRemotelyRss(q) {
	const url = 'https://weworkremotely.com/remote-jobs.rss';
	try {
		const xml = await fetchText(url, 15_000);
		if (!xml) return { source: 'weworkremotely', jobs: [], url };
		const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
		const query = String(q || '').toLowerCase();
		const jobs = [];
		for (const block of items) {
			const title = stripHtml(extractFirst(block, /<title[^>]*>([\s\S]*?)<\/title>/i));
			const link = stripHtml(extractFirst(block, /<link[^>]*>([\s\S]*?)<\/link>/i));
			const pubDate = stripHtml(extractFirst(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i));
			const desc = stripHtml(extractFirst(block, /<description[^>]*>([\s\S]*?)<\/description>/i));
			const full = (title + ' ' + desc).toLowerCase();
			if (!title || !link) continue;
			if (query && !full.includes(query) && !title.toLowerCase().includes(query)) continue;
			jobs.push({ title, company: 'Unknown', location: 'Remote', url: link, date: pubDate, source: 'weworkremotely' });
			if (jobs.length >= 60) break;
		}
		return { source: 'weworkremotely', jobs, url };
	} catch (e) {
		return { source: 'weworkremotely', jobs: [], error: e.message, url };
	}
}

async function fetchWellfoundRss(q) {
	const url = 'https://wellfound.com/jobs.rss?keywords=' + encodeURIComponent(q || 'data analyst') + '&remote=true';
	try {
		const xml = await fetchText(url, 15_000);
		if (!xml) return { source: 'wellfound', jobs: [], url };
		const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
		const jobs = [];
		for (const block of items) {
			const title = stripHtml(extractFirst(block, /<title[^>]*>([\s\S]*?)<\/title>/i));
			const link = stripHtml(extractFirst(block, /<link[^>]*>([\s\S]*?)<\/link>/i));
			const pubDate = stripHtml(extractFirst(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i));
			const desc = stripHtml(extractFirst(block, /<description[^>]*>([\s\S]*?)<\/description>/i));
			if (!title || !link) continue;
			jobs.push({ title, company: 'Unknown', location: 'Remote', url: link, date: pubDate, description: desc, source: 'wellfound' });
			if (jobs.length >= 60) break;
		}
		return { source: 'wellfound', jobs, url };
	} catch (e) {
		return { source: 'wellfound', jobs: [], error: e.message, url };
	}
}

async function fetchRemoteCo(q) {
	const url = 'https://remote.co/remote-jobs/analyst';
	try {
		const html = await fetchText(url, 15_000);
		if (!html) return { source: 'remote_co', jobs: [], url };
		const jobs = [];
		const cards = html.split(/class=["']job_listing["']/i);
		const query = String(q || '').toLowerCase();
		for (const chunk of cards.slice(1)) {
			const href = extractFirst(chunk, /href=["']([^"']+)["']/i);
			const title = stripHtml(extractFirst(chunk, /class=["']position["'][^>]*>([\s\S]*?)<\/a>/i) || extractFirst(chunk, /<a[^>]+>([\s\S]*?)<\/a>/i));
			const company = stripHtml(extractFirst(chunk, /class=["']company["'][^>]*>([\s\S]*?)<\/span>/i));
			const location = stripHtml(extractFirst(chunk, /class=["']location["'][^>]*>([\s\S]*?)<\/span>/i));
			if (!href || !title) continue;
			const fullUrl = href.startsWith('http') ? href : ('https://remote.co' + href);
			if (query && !title.toLowerCase().includes(query) && !title.toLowerCase().includes('analyst') && !query.includes('analyst')) continue;
			jobs.push({ title, company: company || 'Unknown', location: location || 'Remote', url: fullUrl, date: '', source: 'remote_co' });
			if (jobs.length >= 50) break;
		}
		return { source: 'remote_co', jobs, url };
	} catch (e) {
		return { source: 'remote_co', jobs: [], error: e.message, url };
	}
}

async function fetchJobspresso(q) {
	const url = 'https://jobspresso.co/jobs';
	try {
		const html = await fetchText(url, 15_000);
		if (!html) return { source: 'jobspresso', jobs: [], url };
		const jobs = [];
		const query = String(q || '').toLowerCase();
		// Jobspresso uses standard WP job archive links: /job/<slug>
		const re = /<a[^>]+href=["'](https?:\/\/jobspresso\.co\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
		let m;
		while ((m = re.exec(html))) {
			const link = m[1];
			const title = stripHtml(m[2]);
			if (!title || !link) continue;
			if (query && !title.toLowerCase().includes(query) && !title.toLowerCase().includes('analyst') && !query.includes('analyst')) continue;
			jobs.push({ title, company: 'Unknown', location: 'Remote', url: link, date: '', source: 'jobspresso' });
			if (jobs.length >= 50) break;
		}
		return { source: 'jobspresso', jobs, url };
	} catch (e) {
		return { source: 'jobspresso', jobs: [], error: e.message, url };
	}
}

async function fetchAuthenticJobs(q) {
	const url = 'https://authenticjobs.com/?q=' + encodeURIComponent(q || 'data analyst');
	try {
		const html = await fetchText(url, 15_000);
		if (!html) return { source: 'authenticjobs', jobs: [], url };
		const jobs = [];
		// Links look like /jobs/<id>/<slug>/
		const re = /<a[^>]+href=["'](\/jobs\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
		let m;
		while ((m = re.exec(html))) {
			const href = m[1];
			const title = stripHtml(m[2]);
			if (!href || !title) continue;
			if (title.length < 4) continue;
			jobs.push({ title, company: 'Unknown', location: 'Remote', url: 'https://authenticjobs.com' + href, date: '', source: 'authenticjobs' });
			if (jobs.length >= 50) break;
		}
		return { source: 'authenticjobs', jobs, url };
	} catch (e) {
		return { source: 'authenticjobs', jobs: [], error: e.message, url };
	}
}

async function scrapeHimalayas(page, q) {
	try {
		const url = 'https://himalayas.app/jobs?search=' + encodeURIComponent(q || 'data analyst');
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('a[href*=\"/jobs/\"]', { timeout: 12_000 }).catch(() => {});
		const jobs = await page.evaluate(() => {
			const out = [];
			const links = Array.from(document.querySelectorAll('a[href*=\"/jobs/\"]'));
			for (const a of links) {
				const href = a.getAttribute('href') || '';
				if (!href.startsWith('/jobs/')) continue;
				const title = (a.textContent || '').trim();
				if (!title || title.length < 4) continue;
				const url = 'https://himalayas.app' + href;
				out.push({ title, company: 'Unknown', location: 'Remote', url, date: '', source: 'himalayas' });
				if (out.length >= 50) break;
			}
			return out;
		});
		return { source: 'himalayas', jobs: jobs || [], url };
	} catch (e) {
		return { source: 'himalayas', jobs: [], error: e.message };
	}
}

async function scrapeNaukri(page, q, location) {
	try {
		const k = encodeURIComponent(q || 'data analyst');
		const url = `https://www.naukri.com/data-analyst-jobs?k=${k}&experience=2,3&l=${location || ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.jobTupleHeader, .jobCard, [data-job-id]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.jobTupleHeader, .jobCard, [data-job-id]');
			for (const card of cards) {
				const titleEl = card.querySelector('.title a, .jobTitle a');
				if (!titleEl) continue;
				const title = titleEl.textContent.trim();
				const href = titleEl.getAttribute('href') || '';
				const fullUrl = href.startsWith('http') ? href : 'https://www.naukri.com' + href;
				const companyEl = card.querySelector('.companyName, [class*="companyName"]');
				const locEl = card.querySelector('.loc, [class*="loc"]');
				const timeEl = card.querySelector('.fleft, [class*="time"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'naukri'
				});
				if (out.length >= 50) break;
			}
			return out;
		});
		return { source: 'naukri', jobs, url };
	} catch (e) {
		return { source: 'naukri', jobs: [], error: e.message };
	}
}

async function scrapeIndeed(page, q, location) {
	try {
		const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${location || 'remote'}&fromage=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('#mosaic-jobResults, [data-job-key]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const container = document.querySelector('#mosaic-jobResults') || document.body;
			const cards = container.querySelectorAll('[data-job-key], .job_seen_beacon');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/rc/clk?"], a[href*="/viewjob?"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.indeed.com' + href : href;
				const companyEl = card.querySelector('[data-testid="company-name"], .companyName');
				const locEl = card.querySelector('[data-testid="text-location"], .companyLocation');
				const timeEl = card.querySelector('[class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'indeed'
				});
				if (out.length >= 40) break;
			}
			return out;
		});
		return { source: 'indeed', jobs, url };
	} catch (e) {
		return { source: 'indeed', jobs: [], error: e.message };
	}
}

async function scrapeMonster(page, q, location) {
	try {
		const url = `https://www.monster.com/jobs/search/?q=${encodeURIComponent(q)}&where=${location || 'remote'}&postedDate=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.results-card, [data-test-id="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.results-card, [data-test-id="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.monster.com' + href : href;
				const companyEl = card.querySelector('.company, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="location"]');
				const timeEl = card.querySelector('.posted, [class*="posted"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'monster'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'monster', jobs, url };
	} catch (e) {
		return { source: 'monster', jobs: [], error: e.message };
	}
}

async function scrapeFoundit(page, q, location) {
	try {
		const url = `https://www.foundit.in/search/data-analyst-jobs?query=${encodeURIComponent(q)}&location=${location || ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.jobCard, .job-item', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.jobCard, .job-item');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.foundit.in' + href : href;
				const companyEl = card.querySelector('.company-name, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.posted-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'foundit'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'foundit', jobs, url };
	} catch (e) {
		return { source: 'foundit', jobs: [], error: e.message };
	}
}

async function scrapeGlassdoor(page, q, location) {
	try {
		const url = `https://www.glassdoor.com/Job/jobs.htm?suggestCount=0&suggestChosen=false&clickSource=searchBtn&typedKeyword=${encodeURIComponent(q)}&sc.keyword=${encodeURIComponent(q)}&locT=C&locId=1147401&jobType=&fromAge=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.react-job-listing, [data-test="job-listing"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.react-job-listing, [data-test="job-listing"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/partner/"], a[href*="/Job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.glassdoor.com' + href : href;
				const companyEl = card.querySelector('.job-search-key-lmzjyg, [class*="company"]');
				const locEl = card.querySelector('.job-search-key-1m2z0jx, [class*="location"]');
				const timeEl = card.querySelector('.job-search-key-1erf0ry, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'glassdoor'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'glassdoor', jobs, url };
	} catch (e) {
		return { source: 'glassdoor', jobs: [], error: e.message };
	}
}

async function scrapeHirist(page, q) {
	try {
		const slug = (q || 'data analyst').toLowerCase().replace(/\s+/g, '-');
		const url = `https://hirist.com/jobs/${slug}-jobs`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.job-card, .job-item, [data-job-id]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.job-card, .job-item, [data-job-id]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('http') ? href : 'https://hirist.com' + href;
				const companyEl = card.querySelector('.company-name, [class*="company"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: 'India',
					url: fullUrl,
					date: '',
					source: 'hirist'
				});
				if (out.length >= 50) break;
			}
			return out;
		});
		return { source: 'hirist', jobs, url };
	} catch (e) {
		return { source: 'hirist', jobs: [], error: e.message };
	}
}

async function scrapeJobsAaj(page, q, location) {
	try {
		const url = `https://www.jobsaaj.com/search?q=${encodeURIComponent(q)}&location=${location || ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.job-card, .job-listing', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.job-card, .job-listing');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.jobsaaj.com' + href : href;
				const companyEl = card.querySelector('.company, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'jobsaaj'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'jobsaaj', jobs, url };
	} catch (e) {
		return { source: 'jobsaaj', jobs: [], error: e.message };
	}
}

async function scrapeTimesJobs(page, q, location) {
	try {
		const url = `https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=${encodeURIComponent(q)}&txtLocation=${location || ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.joblist, .job-bx, [class*="job"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.joblist, .job-bx, [class*="job-bx"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job-detail/"], a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.timesjobs.com' + href : href;
				const companyEl = card.querySelector('.comp-name, [class*="company"]');
				const locEl = card.querySelector('.loc, [class*="location"]');
				const timeEl = card.querySelector('.posted, [class*="posted"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'timesjobs'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'timesjobs', jobs, url };
	} catch (e) {
		return { source: 'timesjobs', jobs: [], error: e.message };
	}
}

async function scrapeShine(page, q, location) {
	try {
		const url = `https://www.shine.com/job-search/${encodeURIComponent(q)}-jobs${location ? '-' + location : ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.jobCard, .job-listing', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.jobCard, .job-listing, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.shine.com' + href : href;
				const companyEl = card.querySelector('.company-name, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.posted-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'shine'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'shine', jobs, url };
	} catch (e) {
		return { source: 'shine', jobs: [], error: e.message };
	}
}

async function scrapeZipRecruiter(page, q, location) {
	try {
		const url = `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(q)}&location=${location || 'remote'}&days=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.job_content, [data-testid="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.job_content, [data-testid="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.ziprecruiter.com' + href : href;
				const companyEl = card.querySelector('.company_name, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="location"]');
				const timeEl = card.querySelector('.posted_date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'ziprecruiter'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'ziprecruiter', jobs, url };
	} catch (e) {
		return { source: 'ziprecruiter', jobs: [], error: e.message };
	}
}

async function scrapeSimplyHired(page, q, location) {
	try {
		const url = `https://www.simplyhired.com/search?q=${encodeURIComponent(q)}&l=${location || 'remote'}&fdb=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.SerpJob, [class*="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.SerpJob, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.simplyhired.com' + href : href;
				const companyEl = card.querySelector('.jobposting-company, [class*="company"]');
				const locEl = card.querySelector('.jobposting-location, [class*="location"]');
				const timeEl = card.querySelector('.jobposting-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'simplyhired'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'simplyhired', jobs, url };
	} catch (e) {
		return { source: 'simplyhired', jobs: [], error: e.message };
	}
}

async function scrapeCareerBuilder(page, q, location) {
	try {
		const url = `https://www.careerbuilder.com/jobs?keywords=${encodeURIComponent(q)}&location=${location || 'remote'}&posted=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.data-results-content-parent, [class*="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.data-results-content-parent, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.careerbuilder.com' + href : href;
				const companyEl = card.querySelector('.data-details, [class*="company"]');
				const locEl = card.querySelector('.data-details, [class*="location"]');
				const timeEl = card.querySelector('.data-results-publish-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'careerbuilder'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'careerbuilder', jobs, url };
	} catch (e) {
		return { source: 'careerbuilder', jobs: [], error: e.message };
	}
}

async function scrapeDice(page, q, location) {
	try {
		const url = `https://www.dice.com/jobs?q=${encodeURIComponent(q)}&location=${location || 'remote'}&postedDate=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.search-result, [class*="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.search-result, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/jobs/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.dice.com' + href : href;
				const companyEl = card.querySelector('.hidden-phone, [class*="company"]');
				const locEl = card.querySelector('.jobLoc, [class*="location"]');
				const timeEl = card.querySelector('.posted-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'dice'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'dice', jobs, url };
	} catch (e) {
		return { source: 'dice', jobs: [], error: e.message };
	}
}

async function scrapeAdzuna(page, q, location) {
	try {
		const url = `https://www.adzuna.com/search?q=${encodeURIComponent(q)}&where=${location || 'remote'}&days=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.job-result, [class*="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.job-result, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/jobs/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.adzuna.com' + href : href;
				const companyEl = card.querySelector('.company, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.posted, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'adzuna'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'adzuna', jobs, url };
	} catch (e) {
		return { source: 'adzuna', jobs: [], error: e.message };
	}
}

async function scrapeJooble(page, q, location) {
	try {
		const url = `https://jooble.org/SearchResult?ukw=${encodeURIComponent(q)}&rgns=${location || 'remote'}&date=3`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.vacancy, [class*="job-card"]', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.vacancy, [class*="job-card"]');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/job/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://jooble.org' + href : href;
				const companyEl = card.querySelector('.company-name, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : '',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'jooble'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'jooble', jobs, url };
	} catch (e) {
		return { source: 'jooble', jobs: [], error: e.message };
	}
}

async function scrapeFreshersworld(page, q, location) {
	try {
		const url = `https://www.freshersworld.com/jobs/search?q=${encodeURIComponent(q)}&location=${location || ''}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
		await page.waitForSelector('.job-container, .job-item', { timeout: 12_000 }).catch(() => {});
		
		const jobs = await page.evaluate(() => {
			const out = [];
			const cards = document.querySelectorAll('.job-container, .job-item');
			for (const card of cards) {
				const link = card.querySelector('a[href*="/jobs/"]');
				if (!link) continue;
				const title = (link.textContent || '').trim();
				if (!title) continue;
				const href = link.getAttribute('href') || '';
				const fullUrl = href.startsWith('/') ? 'https://www.freshersworld.com' + href : href;
				const companyEl = card.querySelector('.company-name, [class*="company"]');
				const locEl = card.querySelector('.location, [class*="loc"]');
				const timeEl = card.querySelector('.posted-date, [class*="date"]');
				out.push({
					title,
					company: companyEl ? companyEl.textContent.trim() : 'Unknown',
					location: locEl ? locEl.textContent.trim() : 'India',
					url: fullUrl,
					date: timeEl ? timeEl.textContent.trim() : '',
					source: 'freshersworld'
				});
				if (out.length >= 30) break;
			}
			return out;
		});
		return { source: 'freshersworld', jobs, url };
	} catch (e) {
		return { source: 'freshersworld', jobs: [], error: e.message };
	}
}

// Main scraper function
async function scrapeAllPortals(q, days, location, baseUrl) {
	const query = q || 'data analyst';
	const maxDays = parseInt(days, 10) || 3;
	const loc = location || 'remote';
	
	let browser;
	const results = [];
	
	try {
		browser = await puppeteer.launch({
			args: chromium.args,
			defaultViewport: chromium.defaultViewport,
			executablePath: await chromium.executablePath(),
			headless: chromium.headless
		});
		const runWithPage = async (fn) => {
			const page = await browser.newPage();
			page.setDefaultNavigationTimeout(TIMEOUT_MS);
			await page.setUserAgent(USER_AGENT);
			try {
				return await fn(page);
			} finally {
				try { await page.close(); } catch (e) {}
			}
		};

		// Headless portals (need a browser page)
		const headlessTasks = [
			() => runWithPage((p) => scrapeLinkedIn(p, query, loc, '2,3')),
			() => runWithPage((p) => scrapeNaukri(p, query, loc)),
			() => runWithPage((p) => scrapeIndeed(p, query, loc)),
			() => runWithPage((p) => scrapeMonster(p, query, loc)),
			() => runWithPage((p) => scrapeFoundit(p, query, loc)),
			() => runWithPage((p) => scrapeGlassdoor(p, query, loc)),
			() => runWithPage((p) => scrapeHirist(p, query)),
			() => runWithPage((p) => scrapeJobsAaj(p, query, loc)),
			() => runWithPage((p) => scrapeTimesJobs(p, query, loc)),
			() => runWithPage((p) => scrapeShine(p, query, loc)),
			() => runWithPage((p) => scrapeZipRecruiter(p, query, loc)),
			() => runWithPage((p) => scrapeSimplyHired(p, query, loc)),
			() => runWithPage((p) => scrapeCareerBuilder(p, query, loc)),
			() => runWithPage((p) => scrapeDice(p, query, loc)),
			() => runWithPage((p) => scrapeAdzuna(p, query, loc)),
			() => runWithPage((p) => scrapeJooble(p, query, loc)),
			() => runWithPage((p) => scrapeFreshersworld(p, query, loc)),
			() => runWithPage((p) => scrapeHimalayas(p, query))
		];

		const concurrency = 4; // avoid too many pages in serverless
		const headlessResults = [];
		let cursor = 0;
		const workers = new Array(concurrency).fill(0).map(async () => {
			while (cursor < headlessTasks.length) {
				const i = cursor++;
				try {
					headlessResults[i] = await headlessTasks[i]();
				} catch (e) {
					headlessResults[i] = { source: 'unknown', jobs: [], error: e.message };
				}
			}
		});
		await Promise.all(workers);
		headlessResults.forEach((r) => { if (r) results.push(r); });

		// Non-headless remote hiring platforms (API/RSS/HTML fetch)
		const nonHeadless = await Promise.allSettled([
			fetchRemoteOk(query),
			fetchRemotive(query),
			fetchWeWorkRemotelyRss(query),
			fetchWellfoundRss(query),
			fetchRemoteCo(query),
			fetchJobspresso(query),
			fetchAuthenticJobs(query),
			fetchWorkingNomads(baseUrl, query)
		]);
		nonHeadless.forEach((r) => {
			if (r.status === 'fulfilled' && r.value) results.push(r.value);
		});
		
	} catch (e) {
		return { ok: false, error: 'Scraper failed', message: e.message };
	} finally {
		if (browser) {
			try { await browser.close(); } catch (e) {}
		}
	}
	
	// Aggregate all jobs
	let allJobs = [];
	results.forEach((r) => {
		if (r.jobs && Array.isArray(r.jobs)) {
			r.jobs.forEach((j) => {
				allJobs.push({ ...j, source: r.source });
			});
		}
	});

	allJobs = dedupeByUrl(allJobs);
	
	// Filter by date (last N days)
	allJobs = filterByDate(allJobs, maxDays);
	
	// Sort by location (remote first)
	allJobs = sortByLocation(allJobs);
	
	// Store in KV if available
	if (hasKv()) {
		try {
			const { kv } = require('@vercel/kv');
			await kv.setex(CACHE_KEY, CACHE_TTL, {
				jobs: allJobs,
				sources: results.map(r => r.source),
				scrapedAt: new Date().toISOString(),
				count: allJobs.length,
				query,
				days: maxDays,
				location: loc
			});
		} catch (e) {
			console.error('KV storage failed:', e);
		}
	}
	
	return {
		ok: true,
		count: allJobs.length,
		jobs: allJobs,
		sources: results.map(r => r.source),
		results,
		scrapedAt: new Date().toISOString(),
		query,
		days: maxDays,
		location: loc
	};
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
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
	const days = (req.query && req.query.days) ? parseInt(String(req.query.days), 10) : 3;
	const location = (req.query && req.query.location) ? String(req.query.location).trim() : 'remote';
	const force = (req.query && req.query.force) === '1' || (req.query && req.query.force) === 'true';
	const proto = (req.headers && (req.headers['x-forwarded-proto'] || 'https')) || 'https';
	const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
	const baseUrl = host ? (proto + '://' + host) : '';
	
		// If not forcing refresh, try to return cached data first
		if (!force && hasKv()) {
			try {
				const { kv } = require('@vercel/kv');
				const cached = await kv.get(CACHE_KEY);
			if (cached && cached.jobs && Array.isArray(cached.jobs) && cached.jobs.length > 0) {
				// Check if cache is still valid (within TTL)
				const cachedAge = cached.scrapedAt ? (Date.now() - new Date(cached.scrapedAt).getTime()) / 1000 : Infinity;
				if (cachedAge < CACHE_TTL) {
					return res.status(200).json({
						ok: true,
						count: cached.jobs.length,
						jobs: cached.jobs,
						sources: cached.sources || [],
						cached: true,
						scrapedAt: cached.scrapedAt,
						query: cached.query || q,
						days: cached.days || days,
						location: cached.location || location
					});
				}
			}
		} catch (e) {
			// KV read failed, continue to scrape
		}
	}
	
	// Scrape fresh data
	const result = await scrapeAllPortals(q, days, location, baseUrl);
	return res.status(200).json(result);
};
