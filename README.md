# 3d Party — The Actual Third Option

"No, we are not doing 3rd party insurance."

A next-generation digital democracy platform for the Maldives — direct citizen participation, merit-weighted governance, and transparent leadership selection.

## Quick Start
```bash
npm install
npm start
```

## Documentation

| File | What you'll find |
|---|---|
| [`whitepaper.txt`](whitepaper.txt) | Governance philosophy, constitutional design, and phased rollout strategy. |
| [`blueprint.md`](blueprint.md) | **The default technical specification.** System architecture, API reference, database schema, and configuration. |
| [`history.md`](history.md) | Dated implementation log with rationale for every major change. |
| [`REFACTORING.md`](REFACTORING.md) | Backend modularization plan (mostly completed — see `history.md`). |
| [`FRONTEND_REFACTOR_PLAN.md`](FRONTEND_REFACTOR_PLAN.md) | Frontend JS extraction plan (completed). |
| [`AGENTS.md`](AGENTS.md) | Conventions for AI coding assistants. |

## Architecture at a Glance

- **Backend:** Node.js (Express) + better-sqlite3, modular architecture under `src/`
- **Frontend:** Vanilla JS + Tailwind CSS v3 (built locally)
- **Entry:** `server.js` (~150 lines, wiring only)
- **Database:** SQLite (`data/signups.db`) + external `laws.db`
