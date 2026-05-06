module.exports = function({ db, getSettings }) {
  function queueNotification({ type, userId = null, referenceId = null, message, delayMs = 0 }) {
    try {
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const scheduledAt = new Date(now + delayMs).toISOString();

      db.prepare(`
        INSERT INTO notification_queue (type, user_id, reference_id, message, created_at, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(type, userId, referenceId, message, createdAt, scheduledAt);

      return true;
    } catch (e) {
      console.error('Notification queue error:', e);
      return false;
    }
  }

  function processQueue() {
    const settings = getSettings();
    if (!settings.notification_enabled) return { processed: 0 };

    const maxPerBatch = settings.notification_max_per_batch || 3;
    const now = new Date().toISOString();

    try {
      const pending = db.prepare(`
        SELECT * FROM notification_queue
        WHERE posted_at IS NULL AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, id ASC
        LIMIT ?
      `).all(now, maxPerBatch);

      let processed = 0;
      for (const item of pending) {
        try {
          db.prepare(`
            INSERT INTO wall_posts (nickname, message, parent_id, user_id, user_name, is_approved, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run('3rd Party', item.message, null, item.user_id, null, 1, now);

          db.prepare(`
            UPDATE notification_queue SET posted_at = ? WHERE id = ?
          `).run(now, item.id);

          processed++;
        } catch (e) {
          console.error('Failed to post notification:', e);
        }
      }

      const remaining = db.prepare(`
        SELECT COUNT(*) as total FROM notification_queue WHERE posted_at IS NULL
      `).get().total;

      if (processed > 0) {
        console.log(`✓ Posted ${processed} notification(s), ${remaining} remaining in queue`);
      }

      return { processed, remaining };
    } catch (e) {
      console.error('Process notification queue error:', e);
      return { processed: 0, remaining: 0 };
    }
  }

  function getQueueStatus() {
    try {
      const pending = db.prepare(`SELECT COUNT(*) as total FROM notification_queue WHERE posted_at IS NULL`).get().total;
      const total = db.prepare(`SELECT COUNT(*) as total FROM notification_queue`).get().total;
      return { pending, total };
    } catch (e) {
      console.error('Get queue status error:', e);
      return { pending: 0, total: 0 };
    }
  }

  return { queueNotification, processQueue, getQueueStatus };
};
