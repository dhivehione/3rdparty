const express = require('express');
const router = express.Router();
const crypto = require('crypto');

module.exports = function({ db, logActivity, adminSessions, ADMIN_PASSWORD }) {

  // POST /api/login
  router.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      const sessionToken = crypto.randomBytes(32).toString('hex');
      adminSessions.set(sessionToken, { createdAt: Date.now() });
      res.json({ 
        success: true, 
        token: sessionToken,
        message: 'Welcome back. The insurance agents are still locked out.'
      });
    } else {
      res.status(401).json({ 
        success: false, 
        error: 'Wrong password. If you\'re from an insurance company, please leave.' 
      });
    }
  });

  // POST /api/check-registration - Check if NID is registered
  router.post('/api/check-registration', (req, res) => {
    const { nid } = req.body;
    
    if (!nid) {
      return res.status(400).json({ error: 'NID is required', success: false });
    }
    
    try {
      const user = db.prepare('SELECT id, phone, name, username, is_verified FROM signups WHERE nid = ?').get(nid.trim());
      
      if (!user) {
        return res.json({ registered: false, success: true });
      }
      
      res.json({ 
        registered: true, 
        hasUsername: !!user.username,
        success: true 
      });
    } catch (error) {
      console.error('Check registration error:', error);
      res.status(500).json({ error: 'Could not check registration', success: false });
    }
  });

  // POST /api/user/login - User login with phone + NID OR username + password
  router.post('/api/user/login', (req, res) => {
    const { phone, nid, username, password } = req.body;
    
    let user;
    let loginMethod = '';

    if (username && password) {
      // Step 1: Find user by username or NID
      user = db.prepare(`
        SELECT * FROM signups 
        WHERE username = ? OR nid = ?
      `).get(username.trim(), username.trim());
      
      if (user) {
        // Step 2: Verify password
        if (user.password_hash) {
          // Check against stored password hash
          const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
          if (user.password_hash !== passwordHash) {
            return res.status(401).json({ error: 'Invalid credentials', success: false });
          }
          loginMethod = 'password_hash';
        } else {
          // Legacy: phone number as password
          const cleanedPassword = password.replace(/\D/g, '');
          const storedPhone = (user.phone || '').replace(/\D/g, '');
          if (cleanedPassword !== storedPhone) {
            return res.status(401).json({ error: 'Invalid credentials', success: false });
          }
          loginMethod = 'legacy_phone';
        }
        
        // Step 3: Check verification status
        if (!user.is_verified) {
          return res.status(401).json({ error: 'Account not verified. Please complete verification.', success: false });
        }
      }
    } else if (phone && nid) {
      // Phone + NID login
      const cleanedPhone = phone.replace(/\D/g, '');
      user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ?').get(cleanedPhone, nid.trim());
      
      if (user && !user.is_verified) {
        return res.status(401).json({ error: 'Account not verified. Please complete verification.', success: false });
      }
      loginMethod = 'phone_nid';
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials or not registered', success: false });
    }
    
    try {
      // Generate auth token
      const authToken = crypto.randomBytes(32).toString('hex');
      const lastLogin = new Date().toISOString();
      db.prepare('UPDATE signups SET auth_token = ?, last_login = ? WHERE id = ?').run(authToken, lastLogin, user.id);

      logActivity('user_login', user.id, null, { method: loginMethod || 'phone_nid' }, req);
      
      res.json({ 
        success: true, 
        token: authToken,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          username: user.username,
          nid: user.nid,
          email: user.email,
          island: user.island,
          contribution_type: user.contribution_type ? (() => {
            try { return JSON.parse(user.contribution_type); }
            catch(e) { return [user.contribution_type]; }
          })() : [],
          donation_amount: user.donation_amount,
          initial_merit_estimate: user.initial_merit_estimate,
          timestamp: user.timestamp
        }
      });
    } catch (error) {
      console.error('User login error:', error);
      res.status(500).json({ error: 'Login failed', success: false });
    }
  });

  // POST /api/user/logout - User logout
  router.post('/api/user/logout', (req, res) => {
    const { phone, token } = req.body;
    
    // Clear by token if provided (most reliable)
    if (token) {
      const user = db.prepare('SELECT id FROM signups WHERE auth_token = ?').get(token);
      if (user) logActivity('user_logout', user.id, null, null, req);
      db.prepare('UPDATE signups SET auth_token = NULL WHERE auth_token = ?').run(token);
    } else if (phone) {
      // Fallback: clear by phone
      const user = db.prepare('SELECT id FROM signups WHERE phone = ?').get(phone);
      if (user) logActivity('user_logout', user.id, null, null, req);
      db.prepare('UPDATE signups SET auth_token = NULL WHERE phone = ?').run(phone);
    }
    
    res.json({ success: true, message: 'Logged out' });
  });

  return router;
};
