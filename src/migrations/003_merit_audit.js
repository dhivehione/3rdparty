module.exports = {
  up(db) {
    // Index on merit_events for fast user lookups and audit queries
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_merit_events_user_id ON merit_events(user_id)`);
      console.log('✓ Migration: Added idx_merit_events_user_id');
    } catch (e) {
      console.log('⚠ idx_merit_events_user_id index error:', e.message);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_merit_events_created_at ON merit_events(created_at)`);
      console.log('✓ Migration: Added idx_merit_events_created_at');
    } catch (e) {
      console.log('⚠ idx_merit_events_created_at index error:', e.message);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_merit_events_type ON merit_events(event_type)`);
      console.log('✓ Migration: Added idx_merit_events_type');
    } catch (e) {
      console.log('⚠ idx_merit_events_type index error:', e.message);
    }

    // Index on donations for fast user-based lookups
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_donations_user_id ON donations(user_id)`);
      console.log('✓ Migration: Added idx_donations_user_id');
    } catch (e) {
      console.log('⚠ idx_donations_user_id index error:', e.message);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status)`);
      console.log('✓ Migration: Added idx_donations_status');
    } catch (e) {
      console.log('⚠ idx_donations_status index error:', e.message);
    }
  }
};
