const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function initDb(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(path.join(dataDir, 'signups.db'));

  const possiblePaths = [
    process.env.LAWS_DB_PATH,
    '/app/data/laws.db',
    '/data/laws.db',
    path.join(dataDir, 'laws.db')
  ].filter(p => p && fs.existsSync(p));

  const lawsDbPath = possiblePaths[0] || null;

  let lawsDb = null;
  if (lawsDbPath) {
    try {
      lawsDb = new Database(lawsDbPath);
      console.log('✓ Laws database connected:', lawsDbPath);
    } catch (err) {
      console.log('⚠ Could not open laws database:', err.message);
    }
  } else {
    console.log('⚠ Laws database not found. Checked: /app/data/laws.db, /data/laws.db, ./data/laws.db');
    console.log('⚠ Set LAWS_DB_PATH environment variable to point to laws.db');
  }

  return { db, lawsDb };
}

module.exports = { initDb };