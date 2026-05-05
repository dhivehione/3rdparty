# Frontend JS Extraction Plan

**Target:** Extract duplicated inline JavaScript from 11 HTML files into 3 shared utility files.

---

## Phase 1 — Create Shared Utilities (3 new files) ✅ COMPLETE

### 1. `js/utils.js` ✅ (42 lines)

| Function | Duplicated in | Description |
|----------|--------------|-------------|
| `escapeHtml(text)` | admin, profile, index, laws, treasury, proposals, wall, enroll, legislature, generate-law, law-stats (11 files) | XSS-safe HTML escaping via `createElement('div').textContent` |
| `formatTime(isoString)` | index, wall, proposals, laws, legislature, law-stats, generate-law (7 files) | Relative time formatter (`Just now`, `5m ago`, `2d ago`) |
| `formatDate(isoString)` | proposals, treasury, laws, legislature (4 files) | Date formatter (e.g. `Jan 15, 2025`) |
| `formatCurrency(amount)` | treasury, admin, donations (3 files) | Currency formatter (`MVR 1,234`) |

```js
// js/utils.js — will export as window.Utils
const Utils = {
  escapeHtml(text) { ... },
  formatTime(isoString) { ... },
  formatDate(isoString) { ... },
  formatCurrency(amount, currency = 'MVR') { ... }
};
```

### 2. `js/auth.js` ✅ (115 lines) — Authentication token management

| Function | Replaces | 
|----------|----------|
| `Auth.getToken()` | `localStorage.getItem('authToken')` / `'token'` / `'auth_token'` / `'3dparty_admin_token'` |
| `Auth.setToken(token)` | `localStorage.setItem('authToken', ...)` |
| `Auth.clearToken()` | `localStorage.removeItem('authToken')` |
| `Auth.isLoggedIn()` | Checks if token exists |
| `Auth.getUser()` | `localStorage.getItem('user')` parsed |
| `Auth.setUser(user)` | `localStorage.setItem('user', JSON.stringify(user))` |
| `Auth.logout(serverUrlBase)` | Standardized logout: clear storage, call server |
| `Auth.getApiHeaders()` | Returns `{ 'Content-Type': 'application/json', 'Authorization': 'Bearer <token>' }` |

**Design:** `Auth` uses a single localStorage key `_3p_auth` that stores `{ token, user }`. Backward-compatible with existing pages that use different keys by checking old keys on first load and migrating.

### 3. `js/api.js` ✅ (57 lines) — Fetch wrappers with auto-auth

| Function | Usage |
|----------|-------|
| `api.get(url)` | `api.get('/api/signups?page=1')` |
| `api.post(url, body)` | `api.post('/api/login', { password })` |
| `api.put(url, body)` | `api.put('/api/proposals/5', { title: '...' })` |
| `api.del(url)` | `api.del('/api/admin/events/3')` |

- Auto-injects `Authorization: Bearer <token>` from `Auth.getToken()`
- Auto-parses JSON response
- Returns `{ ok, data, status }` normalized shape
- Injects: `api.setAuthGetter(fn)` — so it can work with pages that use their own token storage

---

## Phase 2 — Update HTML Pages (one at a time, smoke test after each)

### Update order (largest → smallest):

| # | File | Lines | Inline JS | Key changes |
|---|------|-------|-----------|-------------|
| 1 | `admin.html` | 2549 | ~1919L | Add 3 `<script src>` lines; replace `escapeHtml`, `fetch()` headers, `localStorage` auth calls |
| 2 | `profile.html` | 1397 | ~910L | Replace auth token mgmt, `escapeHtml`, `fetch()` headers |
| 3 | `proposals.html` | 949 | ~760L | Replace `escapeHtml`, `formatTime`, `fetch()` headers |
| 4 | `wall.html` | 687 | ~490L | Replace auth detection, `escapeHtml`, `formatTime`, `fetch()` headers |
| 5 | `join.html` | 609 | ~390L | Replace `localStorage` token/store after signup |
| 6 | `treasury.html` | 214 | ~90L | Replace `escapeHtml`, `formatCurrency`, `fetch()` headers |
| 7 | `laws.html` | 701 | ~520L | Replace `escapeHtml`, `formatTime`, `fetch()` headers |
| 8 | `legislature.html` | 266 | ~160L | Replace `escapeHtml`, `formatTime` |
| 9 | `generate-law.html` | 859 | ~680L | Replace `escapeHtml`, `fetch()` headers |
| 10 | `index.html` | 456 | ~80L | Replace `escapeHtml`, `formatTime` |
| 11 | `enroll.html` | 653 | ~470L | Replace `escapeHtml` |

### Per-page change pattern:

```html
<!-- Add before </head> or at top of <body> -->
<script src="/js/utils.js"></script>
<script src="/js/auth.js"></script>
<script src="/js/api.js"></script>
```

```diff
- const res = await fetch('/api/login', {
-   method: 'POST',
-   headers: { 'Content-Type': 'application/json' },
-   body: JSON.stringify({ password })
- });
- const result = await res.json();
+ const { ok, data } = await api.post('/api/login', { password });
```

```diff
- localStorage.setItem('authToken', token);
+ Auth.setToken(token);
```

```diff
- function escapeHtml(text) { ... }
- delete that function (now global from utils.js)
```

---

## Phase 3 — Verify

- `node tests/smoke.js` — 18/18 backend endpoints must pass
- Manual: Load each HTML page, verify login/logout works, verify data loads
- Manual: Verify admin login still works (separate auth key `3dparty_admin_token`)

---

## Safety Rules
1. **Never break the running app** — smoke test after EVERY page update
2. **Backward-compatible auth** — `Auth` module checks both old and new localStorage keys
3. **No behavior changes** — pure structural refactoring, same DOM IDs, same event handlers
4. **One page per commit** — easy to bisect if something breaks

---

## Key Decision: Auth Key Standardization

Current state (inconsistent across files):
- `admin.html`: `localStorage['3dparty_admin_token']` 
- `profile.html`: `localStorage['authToken']`, `localStorage['userPhone']`, `localStorage['3dparty_last_login']`
- `wall.html`: `localStorage['auth_token']`, `localStorage['user']` (parsed object)
- `join.html`: `localStorage['token']`, `localStorage['user']` (parsed object), `sessionStorage['contribution_types']`

New standard:
- Admin auth: `localStorage['_3p_admin_token']` (scoped, doesn't collide with user auth)
- User auth: `localStorage['_3p_auth']` = `{ token, user, phone, lastLogin }`
- Backward compat: On `Auth.getToken()`, check new key first, fall back to old keys, migrate to new key

**BUT** — for this first iteration, we'll keep backward compat simple: `Auth.getToken()` checks old keys, `Auth.setToken()` writes to new key. No migration needed; old keys on existing sessions still work.
