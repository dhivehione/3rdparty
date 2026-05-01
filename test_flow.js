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

// Simulate signup with phone containing non-digits
let phoneInput = '999-9999';
let nidInput = 'A999999';

// Clean phone (like in signup)
const cleanedPhone = phoneInput.replace(/\D/g, '');
console.log('Original phone:', phoneInput);
console.log('Cleaned phone:', cleanedPhone);

// Insert into database
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

// Now simulate login with phone containing non-digits
const loginPhoneInput = '999-9999';
const loginNidInput = 'A999999';

// Clean phone for login (like in fixed login endpoint)
const cleanedLoginPhone = loginPhoneInput.replace(/\D/g, '');
console.log('\nLogin attempt:');
console.log('Original login phone:', loginPhoneInput);
console.log('Cleaned login phone:', cleanedLoginPhone);

// Query database
const user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(cleanedLoginPhone, nidInput);

if (user) {
  console.log('\n✅ Login successful!');
  console.log('User found:', {
    id: user.id,
    phone: user.phone,
    nid: user.nid,
    name: user.name
  });
} else {
  console.log('\n❌ Login failed - no user found');
  console.log('Looking for phone:', cleanedLoginPhone, 'and nid:', nidInput);
}

// Cleanup
db.exec('DROP TABLE signups');
db.close();
