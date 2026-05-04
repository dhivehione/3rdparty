module.exports = function(db) {
  return {
    getTableInfo() {
      return db.prepare('PRAGMA table_info(donations)').all();
    },
    insertDynamic(insertCols, placeholders, values) {
      return db.prepare(`INSERT INTO donations (${insertCols.join(', ')}) VALUES (${placeholders})`).run(...values);
    },
    getPending() {
      return db.prepare(`
        SELECT d.*, s.name, s.phone as user_phone FROM donations d
        LEFT JOIN signups s ON d.user_id = s.id WHERE d.status = 'pending' ORDER BY d.created_at DESC
      `).all();
    },
    getById(id) {
      return db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
    },
    updateVerified(id, verifiedAt, verifiedBy) {
      return db.prepare('UPDATE donations SET status = ?, verified_at = ?, verified_by = ? WHERE id = ?').run('verified', verifiedAt, verifiedBy, id);
    },
    updateRejected(id, verifiedAt) {
      return db.prepare('UPDATE donations SET status = ?, verified_at = ? WHERE id = ?').run('rejected', verifiedAt, id);
    },
    getUserByPhoneNid(phone, nid) {
      return db.prepare('SELECT id FROM signups WHERE phone = ? AND nid = ?').get(phone, nid);
    },
    getVerified() {
      return db.prepare('SELECT * FROM donations WHERE status = ?').all('verified');
    },
  };
};
