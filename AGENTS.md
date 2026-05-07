# AGENTS.md

## Code Change Documentation

After **every** code change (no matter how small), you MUST update both files:

### 1. `history.md` — Implementation Log

Add an entry containing:

- **What** was changed
- **Why** the change was made (rationale)
- **Who** made the change (author)

Format:

```markdown
## YYYY-MM-DD — Brief title

### Change title
- **What:** Description of the change
- **Why:** Rationale for the change
- **Who:** Author name
```

Add entries in reverse chronological order (newest first, under the appropriate date section).

### 2. `blueprint.md` — System Architecture

Update any sections affected by the change:

- **Database Schema (§5):** Add/remove/modify tables or columns
- **API Endpoints (§8):** Add/remove/modify endpoints, auth requirements, or modules
- **Settings (§10):** Add/remove/modify configurable settings
- **File Structure (§6):** Add/remove/modify files or directories
- **Architectural Notes (§12):** Add notes for significant design decisions
- **Last updated header:** Update the date in the `> **Last updated:**` line

**Never skip these updates.** The documentation must stay in sync with the codebase at all times.
