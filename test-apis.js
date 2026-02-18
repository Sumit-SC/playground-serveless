/**
 * Test script to verify all job APIs are working and which sources return data.
 * Run: node test-apis.js
 */

const BASE_URL = 'https://playground-serveless.vercel.app';

async function testEndpoint(name, url) {
	try {
		console.log(`\n🔍 Testing: ${name}`);
		console.log(`   URL: ${url}`);
		const start = Date.now();
		const response = await fetch(url, { 
			signal: AbortSignal.timeout(15000) // 15s timeout
		});
		const elapsed = Date.now() - start;
		const data = await response.json();
		
		if (data.ok) {
			console.log(`   ✅ OK (${elapsed}ms)`);
			console.log(`   Count: ${data.count || 0}`);
			if (data.sources) {
				console.log(`   Sources: ${data.sources.join(', ')}`);
			}
			if (data.sourceCounts) {
				console.log(`   Source counts:`, JSON.stringify(data.sourceCounts, null, 2));
			}
			if (data.cached !== undefined) {
				console.log(`   Cached: ${data.cached}`);
			}
			if (data.scrapedAt) {
				console.log(`   Scraped at: ${data.scrapedAt}`);
			}
			return { ok: true, data };
		} else {
			console.log(`   ❌ Failed: ${data.error || data.note || 'Unknown error'}`);
			return { ok: false, data };
		}
	} catch (e) {
		console.log(`   ❌ Error: ${e.message}`);
		return { ok: false, error: e.message };
	}
}

async function main() {
	console.log('🧪 Testing Job APIs\n');
	console.log('='.repeat(60));
	
	// Test 1: jobs-snapshot (should work, uses API/RSS)
	const snapshot = await testEndpoint(
		'jobs-snapshot',
		`${BASE_URL}/api/jobs-snapshot?q=data%20analyst&days=7&limit=20`
	);
	
	// Test 2: jobs-cached (might fail if KV not configured or no cache)
	const cached = await testEndpoint(
		'jobs-cached',
		`${BASE_URL}/api/jobs-cached?q=data%20analyst`
	);
	
	// Test 3: headless-scrape-all-portals (will fail if ENABLE_HEADLESS not set)
	console.log(`\n⚠️  Testing headless scraper (may take 30-60s or timeout if disabled)...`);
	const headless = await testEndpoint(
		'headless-scrape-all-portals',
		`${BASE_URL}/api/headless-scrape-all-portals?q=data%20analyst&days=3&location=remote&force=1`
	);
	
	console.log('\n' + '='.repeat(60));
	console.log('\n📊 Summary:');
	console.log(`   jobs-snapshot: ${snapshot.ok ? '✅ Working' : '❌ Failed'}`);
	console.log(`   jobs-cached: ${cached.ok ? '✅ Working' : '❌ Failed'}`);
	console.log(`   headless-scrape-all-portals: ${headless.ok ? '✅ Working' : '❌ Failed/Disabled'}`);
	
	if (snapshot.ok && snapshot.data) {
		console.log(`\n📈 jobs-snapshot sources: ${snapshot.data.sources?.length || 0}`);
		if (snapshot.data.sourceCounts) {
			Object.entries(snapshot.data.sourceCounts).forEach(([src, count]) => {
				console.log(`   - ${src}: ${count} jobs`);
			});
		}
	}
	
	if (headless.ok && headless.data) {
		console.log(`\n📈 headless-scrape-all-portals sources: ${headless.data.sources?.length || 0}`);
		if (headless.data.results) {
			headless.data.results.forEach((r) => {
				const count = r.jobs?.length || 0;
				const status = r.error ? '❌' : (count > 0 ? '✅' : '⚠️');
				console.log(`   ${status} ${r.source}: ${count} jobs${r.error ? ` (${r.error})` : ''}`);
			});
		}
	}
}

main().catch(console.error);
