// Test the exact flow that was problematic
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'signups.db'));

// Ensure table exists
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

// Clear any existing test data
db.exec('DELETE FROM signups WHERE phone = ? OR nid = ?', ['9999999', 'A999999']);

// Simulate the EXACT signup flow with phone containing no special characters
console.log('=== Testing Signup Flow ===');
const signupPhone = '9999999';
const signupNid = 'A999999';
const signupName = 'Test User';
const signupUsername = 'testuser';
const signupEmail = 'test@example.com';
const signupIsland = 'Male';
const contributionTypes = ['skills'];
const donationAmount = 0;

// Validation (from signup endpoint)
const phoneRegex = /^[0-9]{7}$/;
if (!phoneRegex.test(signupPhone.replace(/\D/g, ''))) {
  console.error('Phone validation failed');
  process.exit(1);
}
const cleanedPhone = signupPhone.replace(/\D/g, '');
console.log('Original phone:', signupPhone);
console.log('Cleaned phone for storage:', cleanedPhone);

const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
if (!nidRegex.test(signupNid.trim())) {
  console.error('NID validation failed');
  process.exit(1);
}

// Check for duplicates
const existing = db.prepare('SELECT id FROM signups WHERE phone = ? OR nid = ?').get(cleanedPhone, signupNid);
if (existing) {
  console.error('Duplicate found');
  process.exit(1);
}

// Calculate merit (simplified)
let initialMerit = 50;
const meritEstimates = {'skills': 250, 'action': 200, 'ideas': 150, 'donation': 100};
contributionTypes.forEach(type => {
  initialMerit += meritEstimates[type] || 0;
});

// Insert user
const timestamp = new Date().toISOString();
const contributionTypeJson = JSON.stringify(contributionTypes);
const stmt = db.prepare(
  'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const result = stmt.run(
  cleanedPhone, 
  signupNid, 
  signupName,
  signupUsername ? signupUsername.trim() : null, 
  signupEmail || null, 
  signupIsland || null, 
  contributionTypeJson, 
  donationAmount,
  initialMerit,
  1,
  null,
  timestamp
);

console.log('✅ User inserted with ID:', result.lastInsertRowid);

// Auto-login after signup (from signup endpoint)
const authToken = Buffer.from(`${cleanedPhone}:${signupNid}:${Date.now()}`).toString('base64');
db.prepare('UPDATE signups SET auth_token = ? WHERE id = ?').run(authToken, result.lastInsertRowid);
console.log('✅ Auth token generated and stored');

// Now test the EXACT login flow that was failing
console.log('\n=== Testing Login Flow (Phone + NID) ===');
const loginPhoneInput = '9999999'; // Same as what was signed up with
const loginNidInput = 'A999999';   // Same as what was signed up with

// This is the FIXED login logic from /api/user/login
if (loginPhoneInput && loginNidInput) {
  // Clean phone input for consistency with validation/storage (THE FIX)
  const cleanedLoginPhone = loginPhoneInput.replace(/\D/g, '');
  console.log('Login phone input:', loginPhoneInput);
  console.log('Cleaned login phone:', cleanedLoginPhone);
  
  const user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(cleanedLoginPhone, loginNidInput);
  
  if (user) {
    console.log('✅ Login successful! User found:');
    console.log('  ID:', user.id);
    console.log('  Phone:', user.phone);
    console.log('  NID:', user.nid);
    console.log('  Name:', user.name);
    
    // Generate new auth token (like login does)
    const newAuthToken = Buffer.from(`${user.phone}:${user.nid}:${Date.now()}`).toString('base64');
    db.prepare('UPDATE signups SET auth_token = ? WHERE id = ?').run(newAuthToken, user.id);
    console.log('✅ New auth token generated for session');
  } else {
    console.log('� Login failed - no user found');
    console.log('  Looking for phone:', cleanedLoginPhone);
    console.log('  Looking for nid:', loginNidInput);
    
    // Debug: show what's actually in the database
    const allUsers = db.prepare('SELECT phone, nid FROM signups').all();
    console.log('  All users in DB:', JSON.stringify(allUsers));
  }
} else {
  console.log('Missing phone or nid for login');
}

// Test username/password login flow too
console.log('\n=== Testing Login Flow (Username + Password) ===');
const usernameInput = 'testuser';
// In this system, password for username login is the phone number
const passwordInput = '9999999'; // This is what user would enter as password

if (usernameInput && passwordInput) {
  // Username can be: NID or custom username
  // Password is: phone number (non-digits removed for comparison) - THIS WAS THE BUG
  const cleanedPassword = passwordInput.replace(/\D/g, '');
  console.log('Username input:', usernameInput);
  console.log('Password input (phone):', passwordInput);
  console.log('Cleaned password (phone):', cleanedPassword);
  
  const user = db.prepare(`
    SELECT * FROM signups 
    WHERE (username = ? OR nid = ?) 
    AND phone = ? AND is_verified = 1
  `).get(usernameInput, usernameInput, cleanedPassword);
  
  if (user) {
    console.log('✅ Username/password login successful! User found:');
    console.log('  ID:', user.id);
    console.log('  Phone:', user.phone);
    console.log('  NID:', user.nid);
    console.log('  Name:', user.name);
    console.log('  Username:', user.username);
  } else {
    console.log('❌ Username/password login failed - no user found');
    console.log('  Looking for username/nid:', usernameInput);
    console.log('  Looking for phone:', cleanedPassword);
    
    // Debug: show what's actually in the database
    const allUsers = db.prepare('SELECT username, nid, phone FROM signups').all();
    console.log('  All users in DB:', JSON.stringify(allUsers));
  }
} else {
  console.log('Missing username or password for login');
}

db.close();
console.log('\n=== Test Complete ===');
