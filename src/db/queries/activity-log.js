module.exports = function(db) {
  return {
    insert(log) {
      return db.prepare(
        'INSERT INTO activity_log (user_id, action, target_id, details, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(log.user_id, log.action, log.target_id, log.details, log.ip_address, log.user_agent, log.created_at);
    },
    getPaginated(limit, offset, filters) {
      let query = 'SELECT * FROM activity_log WHERE 1=1';
      const params = [];
      if (filters.user_id) { query += ' AND user_id = ?'; params.push(filters.user_id); }
      if (filters.action) { query += ' AND action = ?'; params.push(filters.action); }
      if (filters.date_from) { query += ' AND created_at >= ?'; params.push(filters.date_from); }
      if (filters.date_to) { query += ' AND created_at <= ?'; params.push(filters.date_to); }
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      return db.prepare(query).all(...params, limit, offset);
    },
    count(filters) {
      let query = 'SELECT COUNT(*) as count FROM activity_log WHERE 1=1';
      const params = [];
      if (filters.user_id) { query += ' AND user_id = ?'; params.push(filters.user_id); }
      if (filters.action) { query += ' AND action = ?'; params.push(filters.action); }
      if (filters.date_from) { query += ' AND created_at >= ?'; params.push(filters.date_from); }
      if (filters.date_to) { query += ' AND created_at <= ?'; params.push(filters.date_to); }
      return db.prepare(query).get(...params).count;
    },
    countAll() {
      return db.prepare('SELECT COUNT(*) as count FROM activity_log').get().count;
    },
  };
};
