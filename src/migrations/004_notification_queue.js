function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id INTEGER,
      reference_id INTEGER,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      posted_at TEXT
    )
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_queue_scheduled ON notification_queue(posted_at, scheduled_at)`);
  } catch (e) {}

  console.log('✓ Notification queue table created');
}

module.exports = { up };
