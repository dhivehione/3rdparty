function up(db) {
  db.exec(`
    ALTER TABLE peer_endorsements ADD COLUMN application_id INTEGER REFERENCES leadership_applications(id)
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_endorsements_application ON peer_endorsements(application_id)`);
  } catch (e) {}

  console.log('✓ peer_endorsements.application_id column added');
}

module.exports = { up };
