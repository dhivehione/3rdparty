const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'test_signups.db'));

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    nid TEXT NOT NULL,
    name TEXT,
    username TEXT,
    email TEXT,
    island TEXT,
    contribution_type TEXT,
    donation_amount REAL DEFAULT 0,
    initial_merit_estimate INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 1,
    auth_token TEXT,
    timestamp TEXT NOT NULL
  )
`);

// Simulate signup
const phoneInput = '999-9999';
const nidInput = 'A999999';
const cleanedPhone = phoneInput.replace(/\D/g, '');

const stmt = db.prepare(
  'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const result = stmt.run(
  cleanedPhone, 
  nidInput, 
  'Test User',
  'testuser',
  'test@example.com',
  'Male',
  JSON.stringify(['skills']),
  0,
  50,
  1,
  null,
  new Date().toISOString()
);

console.log('Inserted user with ID:', result.lastInsertRowid);

// Now simulate login with username and password (password is phone number)
const usernameInput = 'testuser';
// Password is the phone number - might contain non-digits during login
const passwordInput = '999-9999'; // User enters phone with hyphens

// Clean password for comparison (like in fixed login endpoint)
const cleanedPassword = passwordInput.replace(/\D/g, '');
console.log('\nUsername/password login attempt:');
console.log('Username:', usernameInput);
console.log('Original password (phone):', passwordInput);
console.log('Cleaned password (phone):', cleanedPassword);

// Query database - username can be either username or nid, password is phone
const user = db.prepare(`
  SELECT * FROM signups 
  WHERE (username = ? OR nid = ?) 
  AND phone = ? AND is_verified = 1
`).get(usernameInput, usernameInput, cleanedPassword);

if (user) {
  console.log('\n✅ Username/password login successful!');
  console.log('User found:', {
    id: user.id,
    phone: user.phone,
    nid: user.nid,
    name: user.name,
    username: user.username
  });
} else {
  console.log('\n❌ Username/password login failed - no user found');
  console.log('Looking for username/nid:', usernameInput, 'and phone:', cleanedPassword);
}

// Cleanup
db.exec('DROP TABLE signups');
db.close();
