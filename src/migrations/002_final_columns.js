module.exports = {
  up(db) {
    const migrations = [
      { table: 'referrals', col: 'details', def: 'TEXT' },
      { table: 'activity_log', col: 'details', def: 'TEXT' },
      { table: 'leadership_positions', col: 'details', def: 'TEXT' },
      { table: 'leadership_applications', col: 'details', def: 'TEXT' },
    ];

    migrations.forEach(m => {
      try {
        db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.col} ${m.def}`);
        console.log(`✓ Migration: Added ${m.col} to ${m.table}`);
      } catch (e) {
        // Column exists or other error - ignore
      }
    });

    try {
      db.exec(`ALTER TABLE proposals ADD COLUMN updated_at TEXT`);
      console.log(`✓ Migration: Added updated_at to proposals`);
    } catch (e) {
      // Column exists or other error - ignore
    }
  }
};
