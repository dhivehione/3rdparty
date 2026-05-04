const express = require('express');
const router = express.Router();
const https = require('https');

module.exports = function({ db, getSettings, getClientIp, userAuth }) {
  const enrollRateLimits = new Map();

  function checkEnrollRateLimit(ip) {
    const settings = getSettings();
    const ENROLL_RATE_LIMIT_MS = settings.enroll_rate_limit_ms;
    const ENROLL_MAX_PER_DAY = settings.enroll_max_per_day;
    const now = Date.now();
    const record = enrollRateLimits.get(ip);
    
    if (!record) {
      enrollRateLimits.set(ip, { lastRequest: now, dailyCount: 1, dailyReset: new Date(now + 24*60*60*1000) });
      return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
    }
    
    if (now > record.dailyReset.getTime()) {
      record.dailyCount = 1;
      record.dailyReset = new Date(now + 24*60*60*1000);
      enrollRateLimits.set(ip, record);
      return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
    }
    
    if (record.dailyCount >= ENROLL_MAX_PER_DAY) {
      return { allowed: false, remaining: 0, resetIn: record.dailyReset.getTime() - now };
    }
    
    if (now - record.lastRequest < ENROLL_RATE_LIMIT_MS) {
      return { allowed: false, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: ENROLL_RATE_LIMIT_MS - (now - record.lastRequest) };
    }
    
    record.lastRequest = now;
    record.dailyCount++;
    enrollRateLimits.set(ip, record);
    
    return { allowed: true, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: 0 };
  }

  // Helper: proxy a search request to the external directory API (GET /api/public/search/)
  // Returns a Promise that resolves with { results, count } or rejects
  function directorySearch(apiKey, apiHost, searchFields) {
    const params = new URLSearchParams();
    if (searchFields.q) params.append('q', searchFields.q);
    if (searchFields.name) params.append('name', searchFields.name);
    if (searchFields.island) params.append('island', searchFields.island);
    if (searchFields.atoll) params.append('atoll', searchFields.atoll);
    if (searchFields.profession) params.append('profession', searchFields.profession);
    params.append('limit', String(searchFields.limit || 20));
    if (searchFields.offset) params.append('offset', String(searchFields.offset));

    const path = '/api/public/search/?' + params.toString();

    return new Promise((resolve, reject) => {
      const options = {
        hostname: apiHost,
        path: path,
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          'Accept': 'application/json'
        },
        timeout: 10000
      };

      const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk; });
        proxyRes.on('end', () => {
          if (proxyRes.statusCode >= 400) {
            reject(new Error(`Directory service returned ${proxyRes.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve({ results: parsed.results || [], count: parsed.count || 0 });
          } catch (e) {
            reject(new Error('Invalid response from directory service'));
          }
        });
      });

      proxyReq.on('error', (e) => reject(e));
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Directory service timeout')); });
      proxyReq.end();
    });
  }

  // POST /api/enroll/lookup - Search external directory for members
  // Proxies to external directory API: GET /api/public/search/
  // Used for enrolling friends and family - requires auth, rate limited
  // When only a generic 'query' is provided, searches by name AND island in
  // parallel and merges results so that name-only or island-only searches work.
  router.post('/api/enroll/lookup', userAuth, async (req, res) => {
    const ip = getClientIp(req);
    const rateCheck = checkEnrollRateLimit(ip);

    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Try again later.',
        retry_after_seconds: Math.ceil(rateCheck.resetIn / 1000),
        remaining_daily: 0,
        success: false
      });
    }

    const { query, name, island, atoll, profession, address } = req.body;

    if (!query && !name && !island && !atoll && !profession && !address) {
      return res.status(400).json({
        error: 'At least one search parameter required: query, name, island, atoll, profession, or address',
        success: false
      });
    }

    const apiKey = (process.env.DIRECTORY_API_KEY || '').replace(/[\r\n\t\x00-\x1f]/g, '').trim();
    const apiHost = (process.env.DIRECTORY_API_HOST || '').replace(/[\r\n\t\x00-\x1f]/g, '').trim();
    if (!apiKey || !apiHost) {
      return res.status(503).json({ error: 'Directory service not configured', success: false });
    }

    try {
      let mergedResults = [];

      // When specific fields are provided, do a single targeted search
      if (name || island || atoll || profession || address) {
        // Map legacy 'address' field to generic 'q' since the new API uses q for full-text search
        const searchFields = {
          q: query || address || '',
          name: name || '',
          island: island || '',
          atoll: atoll || '',
          profession: profession || ''
        };
        const result = await directorySearch(apiKey, apiHost, searchFields);
        mergedResults = result.results;
      } else {
        // Generic query only — search by name, island, and via q in parallel,
        // then merge & deduplicate by pid so all lookups return relevant results.
        const searches = [
          directorySearch(apiKey, apiHost, { q: query }),
          directorySearch(apiKey, apiHost, { name: query }),
          directorySearch(apiKey, apiHost, { island: query })
        ];

        const [byQ, byName, byIsland] = await Promise.allSettled(searches);

        const seenPids = new Set();
        const addUnique = (results) => {
          for (const r of results) {
            if (!seenPids.has(r.pid)) {
              seenPids.add(r.pid);
              mergedResults.push(r);
            }
          }
        };

        if (byQ.status === 'fulfilled') addUnique(byQ.value.results);
        if (byName.status === 'fulfilled') addUnique(byName.value.results);
        if (byIsland.status === 'fulfilled') addUnique(byIsland.value.results);
      }

      if (mergedResults.length > 0) {
        const first = mergedResults[0];
        console.log('[Directory Search] sample result keys:', Object.keys(first));
        console.log('[Directory Search] sample result:', JSON.stringify(first).substring(0, 800));
      }
      console.log(`[Directory Search] merged ${mergedResults.length} results`);

      res.json({
        success: true,
        results: mergedResults,
        total_count: mergedResults.length,
        rate_limit: {
          remaining_daily: rateCheck.remaining,
          reset_in_seconds: rateCheck.resetIn > 0 ? Math.ceil(rateCheck.resetIn / 1000) : null
        }
      });
    } catch (e) {
      console.error(`[Directory Search] error: ${e.message}`);
      if (e.message.includes('returned')) {
        return res.status(502).json({ error: e.message, success: false });
      }
      if (e.message.includes('timeout')) {
        return res.status(504).json({ error: e.message, success: false });
      }
      res.status(502).json({ error: 'Directory service unavailable: ' + e.message, success: false });
    }
  });

  return router;
};
