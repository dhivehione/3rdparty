/**
 * Smoke Test — verify the app starts and key endpoints respond.
 * Run with: node tests/smoke.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3999; // use a non-standard port so we don't collide
const BASE = `http://localhost:${PORT}`;

let server;
let passed = 0;
let failed = 0;

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function check(label, method, path, expectedStatus = 200, body = null) {
  try {
    const res = await request(method, path, body);
    if (res.status === expectedStatus || (expectedStatus === 200 && res.status < 400)) {
      console.log(`  ✓ ${label} — ${res.status}`);
      passed++;
    } else {
      console.log(`  ✗ ${label} — expected ~${expectedStatus}, got ${res.status}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ ${label} — ERROR: ${e.message}`);
    failed++;
  }
}

async function run() {
  console.log('Starting server for smoke test...');
  server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'smoke-test-admin' },
    stdio: 'pipe',
  });

  server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 2500));

  console.log('\n--- Smoke Tests ---');

  // Static pages
  await check('GET /', 'GET', '/');
  await check('GET /join', 'GET', '/join');
  await check('GET /admin', 'GET', '/admin');

  // API — no auth required
  await check('GET /api/public-settings', 'GET', '/api/public-settings');
  await check('GET /api/signups/count', 'GET', '/api/signups/count');
  await check('GET /api/analytics/active', 'GET', '/api/analytics/active');
  await check('POST /api/analytics/heartbeat', 'POST', '/api/analytics/heartbeat', 200, { session_id: 'smoke-test' });
  await check('GET /api/wall', 'GET', '/api/wall');
  await check('GET /api/proposals', 'GET', '/api/proposals');
  await check('GET /api/emeritus', 'GET', '/api/emeritus');
  await check('GET /api/leadership/public', 'GET', '/api/leadership/public');
  await check('GET /api/events', 'GET', '/api/events');
  await check('GET /api/legislation-stats', 'GET', '/api/legislation-stats');
  await check('GET /api/treasury/summary', 'GET', '/api/treasury/summary');
  await check('GET /api/donation-info', 'GET', '/api/donation-info');
  await check('GET /api/stats/new-joins', 'GET', '/api/stats/new-joins?last_login=2024-01-01T00:00:00.000Z');

  // API — auth required (expect 401 or 403, not 500)
  await check('GET /api/user/profile (no auth)', 'GET', '/api/user/profile', 401);
  await check('GET /api/admin/proposals (no auth)', 'GET', '/api/admin/proposals', 401);

  console.log('\n--- Results ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Smoke test runner error:', err);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
