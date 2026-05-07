module.exports = {
  up(db) {
    try {
      db.exec(`ALTER TABLE referrals ADD COLUMN first_login_at TEXT`);
      console.log(`✓ Migration: Added first_login_at to referrals`);
    } catch (e) {
      // Column exists or other error - ignore
    }

    try {
      db.exec(`ALTER TABLE referrals ADD COLUMN upfront_merit_awarded REAL DEFAULT 0`);
      console.log(`✓ Migration: Added upfront_merit_awarded to referrals`);
    } catch (e) {
      // Column exists or other error - ignore
    }
  }
};
