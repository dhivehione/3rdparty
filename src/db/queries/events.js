module.exports = function(db) {
  return {
    getUpcoming() {
      return db.prepare("SELECT * FROM events WHERE event_date >= date('now') ORDER BY event_date ASC").all();
    },
    getAll() {
      return db.prepare('SELECT * FROM events ORDER BY event_date ASC').all();
    },
    getById(id) {
      return db.prepare('SELECT id, title FROM events WHERE id = ?').get(id);
    },
    create(event) {
      return db.prepare('INSERT INTO events (title, description, event_date, location, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(event.title, event.description, event.event_date, event.location, event.created_at);
    },
    update(id, title, description, eventDate, location) {
      return db.prepare('UPDATE events SET title = ?, description = ?, event_date = ?, location = ? WHERE id = ?')
        .run(title, description, eventDate, location, id);
    },
    delete(id) {
      return db.prepare('DELETE FROM events WHERE id = ?').run(id);
    },
  };
};
