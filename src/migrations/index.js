function runMigrations(deps) {
  const { db } = deps;

  // Detect if this is an existing database that predates schema_version tracking
  const hasSignups = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signups'").get();

  // Create schema_version tracking table
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));

  // Migration 1: initial schema
  if (!applied.has(1)) {
    if (!hasSignups) {
      // Fresh DB — run the full initial schema
      const { runMigrations: run001 } = require('./001_initial_schema');
      run001(deps);
    } else {
      // Existing DB — tables already exist from old src/db/migrations.js
      console.log('✓ Migration 1 skipped (existing database)');
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    console.log('✓ Migration 1 recorded');
  }

  // Migration 2: final column additions
  if (!applied.has(2)) {
    const m002 = require('./002_final_columns');
    m002.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
    console.log('✓ Migration 2 applied');
  }

  // Migration 3: merit audit indexes
  if (!applied.has(3)) {
    const m003 = require('./003_merit_audit');
    m003.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
    console.log('✓ Migration 3 applied');
  }

  // Migration 4: notification queue
  if (!applied.has(4)) {
    const m004 = require('./004_notification_queue');
    m004.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
    console.log('✓ Migration 4 applied');
  }

  // Migration 5: endorsement-application binding
  if (!applied.has(5)) {
    const m005 = require('./005_endorsement_application');
    m005.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
    console.log('✓ Migration 5 applied');
  }

  // Migration 6: referral login merit tracking
  if (!applied.has(6)) {
    const m006 = require('./006_referral_login_merit');
    m006.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
    console.log('✓ Migration 6 applied');
  }

  // Migration 7: merit audit backfill (signup_base + missing referral_base events)
  if (!applied.has(7)) {
    const m007 = require('./007_merit_backfill');
    m007.up(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
    console.log('✓ Migration 7 applied');
  }
}

module.exports = { runMigrations };
