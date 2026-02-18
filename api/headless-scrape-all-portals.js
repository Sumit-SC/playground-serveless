/**
 * Unified headless scraper for all major job portals.
 * Scrapes: LinkedIn, Naukri, Indeed, Monster, Foundit, Glassdoor, Hirist, JobsAaj,
 *         TimesJobs, Shine, ZipRecruiter, SimplyHired, CareerBuilder, Dice, Adzuna, Jooble, Freshersworld
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
async function scrapeAllPortals(q, days, location) {
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
		
		const page = await browser.newPage();
		page.setDefaultNavigationTimeout(TIMEOUT_MS);
		await page.setUserAgent(USER_AGENT);
		
		// Scrape all portals in parallel (with individual timeouts)
		const scrapers = [
			scrapeLinkedIn(page, query, loc, '2,3').catch(e => ({ source: 'linkedin', jobs: [], error: e.message })),
			scrapeNaukri(page, query, loc).catch(e => ({ source: 'naukri', jobs: [], error: e.message })),
			scrapeIndeed(page, query, loc).catch(e => ({ source: 'indeed', jobs: [], error: e.message })),
			scrapeMonster(page, query, loc).catch(e => ({ source: 'monster', jobs: [], error: e.message })),
			scrapeFoundit(page, query, loc).catch(e => ({ source: 'foundit', jobs: [], error: e.message })),
			scrapeGlassdoor(page, query, loc).catch(e => ({ source: 'glassdoor', jobs: [], error: e.message })),
			scrapeHirist(page, query).catch(e => ({ source: 'hirist', jobs: [], error: e.message })),
			scrapeJobsAaj(page, query, loc).catch(e => ({ source: 'jobsaaj', jobs: [], error: e.message })),
			scrapeTimesJobs(page, query, loc).catch(e => ({ source: 'timesjobs', jobs: [], error: e.message })),
			scrapeShine(page, query, loc).catch(e => ({ source: 'shine', jobs: [], error: e.message })),
			scrapeZipRecruiter(page, query, loc).catch(e => ({ source: 'ziprecruiter', jobs: [], error: e.message })),
			scrapeSimplyHired(page, query, loc).catch(e => ({ source: 'simplyhired', jobs: [], error: e.message })),
			scrapeCareerBuilder(page, query, loc).catch(e => ({ source: 'careerbuilder', jobs: [], error: e.message })),
			scrapeDice(page, query, loc).catch(e => ({ source: 'dice', jobs: [], error: e.message })),
			scrapeAdzuna(page, query, loc).catch(e => ({ source: 'adzuna', jobs: [], error: e.message })),
			scrapeJooble(page, query, loc).catch(e => ({ source: 'jooble', jobs: [], error: e.message })),
			scrapeFreshersworld(page, query, loc).catch(e => ({ source: 'freshersworld', jobs: [], error: e.message }))
		];
		
		const portalResults = await Promise.allSettled(scrapers);
		portalResults.forEach((result, idx) => {
			if (result.status === 'fulfilled' && result.value) {
				results.push(result.value);
			}
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
	const result = await scrapeAllPortals(q, days, location);
	return res.status(200).json(result);
};
