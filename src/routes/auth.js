const express = require('express');
const router = express.Router();
const crypto = require('crypto');

module.exports = function({ db, getSettings, logActivity, adminAuth, adminSessions, ADMIN_PASSWORD, sanitizeHTML, generateOTP, getReferralPoints, addTreasuryEntry, getTreasuryBalance }) {
  const { sendSMS } = require('../services/sms');

  // POST /api/verify-otp — Verify OTP code to activate account
  router.post('/api/verify-otp', (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP code required', success: false });
    }

    const cleanedPhone = phone.replace(/\D/g, '');

    try {
      const user = db.prepare(
        'SELECT id, otp_code, otp_expires_at, otp_verified FROM signups WHERE phone = ? AND is_verified = 0'
      ).get(cleanedPhone);

      if (!user) {
        return res.status(404).json({ error: 'No pending verification found for this phone', success: false });
      }

      if (user.otp_verified) {
        return res.status(400).json({ error: 'Account already verified', success: false });
      }

      if (new Date(user.otp_expires_at) < new Date()) {
        return res.status(400).json({ error: 'OTP has expired. Please request a new code.', success: false });
      }

      if (user.otp_code !== otp.trim()) {
        return res.status(400).json({ error: 'Incorrect verification code. Please try again.', success: false });
      }

      // Verify the account
      const authToken = crypto.randomBytes(32).toString('hex');
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ?, otp_code = NULL, otp_expires_at = NULL, last_login = ? WHERE id = ?'
      ).run(authToken, now, user.id);

      // Auto-post welcome
      const verifiedUser = db.prepare('SELECT name, username FROM signups WHERE id = ?').get(user.id);
      const displayName = sanitizeHTML(verifiedUser.name || verifiedUser.username || 'A new member');
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
      const targetMembers = getSettings().target_members ?? 13000;
      const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
      try {
        db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
          .run('admin', `🌴 ${displayName} verified and joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`, now, 'new_members_welcome');
      } catch (e) {}

      // Handle referral completion
      const pendingReferral = db.prepare(`
        SELECT * FROM referrals WHERE status = 'pending_waiting' AND details LIKE ?
      `).get(`%${phone}%`);
      if (pendingReferral) {
        try {
          const details = JSON.parse(pendingReferral.details || '{}');
          if (details.phone === phone) {
            const inviteCount = db.prepare(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND status IN ('joined', 'active')`).get(pendingReferral.referrer_id).count;
            const basePoints = getReferralPoints(inviteCount + 1, false);
            db.prepare(`UPDATE referrals SET referred_id = ?, status = 'joined', base_reward_given = ?, referred_joined_at = ? WHERE id = ?`)
              .run(user.id, basePoints, now, pendingReferral.id);
            db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
              .run(basePoints, pendingReferral.referrer_id);
          }
        } catch (e) {}
      }

      logActivity('user_verified', user.id, null, {}, req);

      // Record signup donation in Live Treasury ledger if user donated at signup
      const verifiedSignup = db.prepare('SELECT donation_amount, name, username FROM signups WHERE id = ?').get(user.id);
      if (verifiedSignup && verifiedSignup.donation_amount > 0) {
        const donorNick = verifiedSignup.username || verifiedSignup.name || ('Member #' + user.id);
        addTreasuryEntry({
          type: 'donation',
          amount: verifiedSignup.donation_amount,
          description: 'Signup donation',
          category: 'donation',
          sourceRefType: 'signup',
          sourceRefId: user.id,
          donorNickname: donorNick,
          verifiedBy: 'system',
          status: 'verified'
        });
      }

      res.json({
        success: true,
        message: 'Phone verified! Welcome to the 3d Party.',
        token: authToken,
        user_id: user.id
      });
    } catch (error) {
      console.error('OTP verify error:', error);
      res.status(500).json({ error: 'Verification failed', success: false });
    }
  });

  // POST /api/resend-otp — Resend OTP code
  router.post('/api/resend-otp', async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number required', success: false });
    }

    const cleanedPhone = phone.replace(/\D/g, '');

    try {
      const user = db.prepare(
        'SELECT id, otp_verified FROM signups WHERE phone = ? AND is_verified = 0'
      ).get(cleanedPhone);

      if (!user) {
        return res.status(404).json({ error: 'No pending verification found for this phone', success: false });
      }

      if (user.otp_verified) {
        return res.status(400).json({ error: 'Account already verified', success: false });
      }

      const settings = getSettings();
      const newOTP = generateOTP(settings.sms_otp_length);
      const newExpiry = new Date(Date.now() + (settings.sms_otp_expiry_minutes * 60 * 1000)).toISOString();

      db.prepare('UPDATE signups SET otp_code = ?, otp_expires_at = ? WHERE id = ?')
        .run(newOTP, newExpiry, user.id);

      // Try to send SMS
      const smsResult = await sendSMS(phone, `Your 3d Party verification code: ${newOTP}. Valid for ${settings.sms_otp_expiry_minutes} minutes.`, settings);

      const response = {
        success: true,
        message: 'New verification code sent',
        otp_sent: smsResult ? smsResult.sent : false
      };

      if (!settings.sms_provider) {
        response.dev_otp = newOTP;
      }

      res.json(response);
    } catch (error) {
      console.error('Resend OTP error:', error);
      res.status(500).json({ error: 'Could not resend code', success: false });
    }
  });

  // POST /api/signup - New signup
  router.post('/api/signup', async (req, res) => {
    const { phone, nid, name, username, email, island, contribution_types, donation_amount } = req.body;
    
    // Validate mandatory fields
    if (!phone || !nid) {
      return res.status(400).json({ 
        error: 'Phone and NID are mandatory — even insurance agents need these.',
        success: false 
      });
    }

    // Check for duplicate username if provided
    if (username) {
      const existingUsername = db.prepare('SELECT id FROM signups WHERE username = ?').get(username.trim());
      if (existingUsername) {
        return res.status(409).json({ 
          error: 'Username already taken. Choose a different one.',
          success: false 
        });
      }
    }
    
    // Validate contribution_types is array if provided
    let validTypes = ['skills', 'action', 'ideas', 'donation'];
    let typesArray = [];
    if (contribution_types) {
      if (!Array.isArray(contribution_types)) {
        return res.status(400).json({ 
          error: 'contribution_types must be an array.',
          success: false 
        });
      }
      typesArray = contribution_types.filter(t => validTypes.includes(t));
      if (typesArray.length !== contribution_types.length) {
        return res.status(400).json({ 
          error: 'Invalid contribution type. Choose from: skills, action, ideas, donation.',
          success: false 
        });
      }
    }
    
     // Basic phone validation (Maldivian format: 7 digits)
     const phoneRegex = /^[0-9]{7}$/;
     if (!phoneRegex.test(phone.replace(/\D/g, ''))) {
       return res.status(400).json({ 
         error: 'Please enter a valid 7-digit phone number.',
         success: false 
       });
     }
     // Clean phone number to store only digits (consistent with validation and login)
     const cleanedPhone = phone.replace(/\D/g, '');
    
    // Basic NID validation
    const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
    if (!nidRegex.test(nid.trim())) {
      return res.status(400).json({ 
        error: 'Please enter a valid NID (e.g., A123456).',
        success: false 
      });
    }
    
     // Check for duplicate phone or NID
     const existing = db.prepare('SELECT id FROM signups WHERE phone = ? OR nid = ?').get(cleanedPhone, nid);
    if (existing) {
      return res.status(409).json({ 
        error: 'You\'re already in the party! One membership per person, please.',
        success: false 
      });
    }
    
    // Calculate initial merit estimate based on contribution types
    const settings = getSettings();
    const meritEstimates = {
      'skills': settings.merit_skills,
      'action': settings.merit_action,
      'ideas': settings.merit_ideas,
      'donation': settings.merit_donation
    };
    let initialMerit = settings.signup_base_merit;
    typesArray.forEach(type => {
      initialMerit += meritEstimates[type] || 0;
    });
    initialMerit += Math.floor(Math.random() * settings.signup_random_bonus_max);
    
    // Validate donation amount
    let finalDonation = 0;
    if (typesArray.includes('donation') && donation_amount) {
      finalDonation = parseFloat(donation_amount);
      if (isNaN(finalDonation) || finalDonation <= 0) {
        return res.status(400).json({
          error: 'Please enter a valid donation amount.',
          success: false
        });
      }
      let donationMerit;
      if (settings.donation_formula === 'flat') {
        donationMerit = Math.floor(finalDonation / settings.donation_divisor_mvr) * settings.donation_bonus_per_100;
      } else {
        const amountUsd = finalDonation / settings.donation_usd_mvr_rate;
        donationMerit = Math.round(settings.donation_log_multiplier * Math.log(amountUsd + 1) / Math.log(5));
      }
      initialMerit += donationMerit;
    }
    
     try {
       const timestamp = new Date().toISOString();
       const contributionTypeJson = JSON.stringify(typesArray);

       // Generate OTP
       const otpCode = generateOTP(settings.sms_otp_length);
       const otpExpiry = new Date(Date.now() + (settings.sms_otp_expiry_minutes * 60 * 1000)).toISOString();
       const requireOTP = settings.sms_otp_required;
       const initialVerifyState = requireOTP ? 0 : 1;
       const initialAuthToken = requireOTP ? null : crypto.randomBytes(32).toString('hex');

       const stmt = db.prepare(
         'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, otp_code, otp_expires_at, otp_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
       );
       const result = stmt.run(
         cleanedPhone, 
         nid, 
         name || null,
         username ? username.trim() : null, 
         email || null, 
         island || null, 
         contributionTypeJson, 
         finalDonation,
         initialMerit,
         initialVerifyState,
         otpCode,
         otpExpiry,
         requireOTP ? 0 : 1,
         initialAuthToken,
         timestamp
       );
      
      // Send SMS OTP
      let smsResult = null;
      if (requireOTP) {
        smsResult = await sendSMS(phone, `Your 3d Party verification code: ${otpCode}. Valid for ${settings.sms_otp_expiry_minutes} minutes.`, settings);
      }

      // Auto-login after signup (only if OTP not required)
      let authToken = initialAuthToken;
      if (!requireOTP) {
        const userLoginToken = db.prepare('SELECT auth_token FROM signups WHERE id = ?').get(result.lastInsertRowid);
        authToken = userLoginToken ? userLoginToken.auth_token : authToken;
      } else if (requireOTP && !settings.sms_provider) {
        // Dev mode: auto-verify immediately if no SMS provider configured
        authToken = crypto.randomBytes(32).toString('hex');
        db.prepare('UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ? WHERE id = ?')
          .run(authToken, result.lastInsertRowid);
      }
      
      // Only process referrals, activity log, and welcome post if user is verified
      if (authToken) {
        // Record signup donation in Live Treasury ledger
        if (finalDonation > 0) {
          const displayNick = username ? username.trim() : (name || ('Member #' + result.lastInsertRowid));
          addTreasuryEntry({
            type: 'donation',
            amount: finalDonation,
            description: 'Signup donation',
            category: 'donation',
            sourceRefType: 'signup',
            sourceRefId: result.lastInsertRowid,
            donorNickname: displayNick,
            verifiedBy: 'system',
            status: 'verified'
          });
        }

        // Check for pending referrals
        const pendingReferral = db.prepare(`
          SELECT * FROM referrals 
          WHERE status = 'pending_waiting' AND details LIKE ?
        `).get(`%${phone}%`);
        
        if (pendingReferral) {
          const details = JSON.parse(pendingReferral.details || '{}');
          if (details.phone === phone) {
            const inviteCount = db.prepare(`
              SELECT COUNT(*) as count FROM referrals 
              WHERE referrer_id = ? AND status IN ('joined', 'active')
            `).get(pendingReferral.referrer_id).count;
            
            const basePoints = getReferralPoints(inviteCount + 1, false);
            
            db.prepare(`
              UPDATE referrals SET referred_id = ?, status = 'joined', 
              base_reward_given = ?, referred_joined_at = ?
              WHERE id = ?
            `).run(result.lastInsertRowid, basePoints, timestamp, pendingReferral.id);
            
            db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
              .run(basePoints, pendingReferral.referrer_id);
            
            logActivity('referral_completed', pendingReferral.referrer_id, result.lastInsertRowid, {
              base_points_awarded: basePoints,
              referrer_invite_count: inviteCount + 1
            }, req);
          }
        }
        
        // Log the signup activity
        logActivity('user_signup', result.lastInsertRowid, null, {
          phone: phone.substring(0, 3) + 'xxxx',
          has_username: !!username
        }, req);
        
        // Get current member count
        const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
        const targetMembers = getSettings().target_members ?? 13000;
        const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
        
        // Auto-post to welcome thread
        const displayName = sanitizeHTML(name || username || 'A new member');
        const welcomeMsg = `🌴 ${displayName} just joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`;
        try {
          db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
            .run('admin', welcomeMsg, timestamp, 'new_members_welcome');
        } catch (e) {
          console.log('Could not post welcome to wall:', e.message);
        }
      }
      
      // Get the user data to return
      const user = db.prepare('SELECT * FROM signups WHERE id = ?').get(result.lastInsertRowid);
      
      const responseBody = { 
        message: `Welcome to the 3d Party! Your initial Merit Score estimate is ${initialMerit} points.`,
        success: true,
        token: authToken,
        otp_required: requireOTP && !authToken,
        otp_sent: smsResult ? smsResult.sent : false,
        otp_expires_in_minutes: requireOTP ? settings.sms_otp_expiry_minutes : 0,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          nid: user.nid,
          email: user.email,
          island: user.island,
          contribution_type: user.contribution_type ? (() => {
            try { return JSON.parse(user.contribution_type); }
            catch(e) { return [user.contribution_type]; }
          })() : [],
          donation_amount: user.donation_amount,
          initial_merit_estimate: user.initial_merit_estimate,
          timestamp: user.timestamp,
          is_verified: !!authToken
        }
      };

      // In dev mode (no SMS provider), include OTP in response for testing
      if (requireOTP && !settings.sms_provider && !authToken) {
        responseBody.dev_otp = otpCode;
      }

      res.status(201).json(responseBody);
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ 
        error: 'Something went wrong on our end. We\'re working on it.',
        success: false 
      });
    }
  });

  // POST /api/unregister - Unregister a user (admin only)
  router.post('/api/unregister', adminAuth, (req, res) => {
    const { user_id, justification } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required', success: false });
    }
    
    if (!justification || justification.trim().length < 10) {
      return res.status(400).json({ error: 'Justification note required (min 10 characters)', success: false });
    }
    
    try {
      const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
      if (!user) {
        return res.status(404).json({ error: 'User not found', success: false });
      }
      
      const unregisteredAt = new Date().toISOString();
      db.prepare(`
        UPDATE signups 
        SET is_verified = 0, unregistered_at = ?, unregistered_by = 'admin', unregister_justification = ?
        WHERE id = ?
      `).run(unregisteredAt, justification.trim(), user_id);
      
      res.json({ 
        message: `User ${user.name || user.phone} has been unregistered.`,
        success: true 
      });
    } catch (error) {
      console.error('Unregister error:', error);
      res.status(500).json({ error: 'Could not unregister user', success: false });
    }
  });

  // POST /api/reregister - Re-register an unregistered user (admin only)
  router.post('/api/reregister', adminAuth, (req, res) => {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required', success: false });
    }
    
    try {
      const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
      if (!user) {
        return res.status(404).json({ error: 'User not found', success: false });
      }
      
      if (user.is_verified === 1) {
        return res.status(400).json({ error: 'User is already verified', success: false });
      }
      
      db.prepare(`
        UPDATE signups 
        SET is_verified = 1, unregistered_at = NULL, unregistered_by = NULL, unregister_justification = NULL
        WHERE id = ?
      `).run(user_id);
      
      res.json({ 
        message: `User ${user.name || user.phone || '#' + user_id} has been re-registered.`,
        success: true 
      });
    } catch (error) {
      console.error('Reregister error:', error);
      res.status(500).json({ error: 'Could not re-register user', success: false });
    }
  });

  // GET /api/signups/count - Get signup count (public)
  router.get('/api/signups/count', (req, res) => {
    try {
      const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      res.json({ total: count.total, success: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch count', success: false });
    }
  });

  // GET /api/stats/new-joins - Get number of new members since last visit
  // Query param: last_login (ISO timestamp)
  router.get('/api/stats/new-joins', (req, res) => {
    const { last_login } = req.query;
    
    if (!last_login) {
      return res.status(400).json({ error: 'last_login parameter required', success: false });
    }
    
    try {
      const sinceDate = last_login.replace(/'/g, "''");
      const newJoins = db.prepare(`
        SELECT COUNT(*) as total FROM signups 
        WHERE timestamp > ?
      `).get(sinceDate);
      
      const totalMembers = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      
      res.json({
        new_joins: newJoins.total,
        total_members: totalMembers.total,
        success: true
      });
    } catch (error) {
      console.error('New joins stats error:', error);
      res.status(500).json({ error: 'Could not fetch stats', success: false });
    }
  });

  // GET /api/signups - Get all signups (admin only, with pagination)
  router.get('/api/signups', adminAuth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      
      const signups = db.prepare('SELECT * FROM signups ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
      const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      const treasury = getTreasuryBalance();
      const donorCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE donation_amount > 0').get();
      const today = new Date().toISOString().split('T')[0];
      const todayCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE timestamp >= ?').get(today);
      
      const parsedSignups = signups.map(s => ({
        ...s,
        contribution_type: s.contribution_type ? (() => {
          try { return JSON.parse(s.contribution_type); }
          catch(e) { return [s.contribution_type]; }
        })() : []
      }));
      
      res.json({ 
        signups: parsedSignups,
        total: count.total,
        total_treasury: treasury,
        donor_count: donorCount.total,
        today_count: todayCount.total,
        page: page,
        limit: limit,
        totalPages: Math.ceil(count.total / limit),
        success: true 
      });
    } catch (error) {
      console.error('Fetch error:', error);
      res.status(500).json({ 
        error: 'Database error',
        success: false 
      });
    }
  });

  // DELETE /api/signups - Clear all signups (admin only)
  router.delete('/api/signups', adminAuth, (req, res) => {
    try {
      db.prepare('DELETE FROM signups').run();
      res.json({ 
        message: 'All signups cleared. Database is now as empty as traditional party promises.',
        success: true 
      });
    } catch (error) {
      console.error('Delete error:', error);
      res.status(500).json({ 
        error: 'Could not clear database',
        success: false 
      });
    }
  });

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
    
    // Determine login method
    let user;
    let loginMethod = '';

    if (username && password) {
      // Username + password login
      // username can be: NID or custom username
      // First try password_hash-based login
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      user = db.prepare(`
        SELECT * FROM signups 
        WHERE (username = ? OR nid = ?) 
        AND password_hash = ? AND is_verified = 1
      `).get(username.trim(), username.trim(), passwordHash);
      loginMethod = 'password_hash';

      // Fallback: if no password_hash set, try phone-as-password (legacy)
      if (!user) {
        const cleanedPassword = password.replace(/\D/g, '');
        user = db.prepare(`
          SELECT * FROM signups 
          WHERE (username = ? OR nid = ?) 
          AND phone = ? AND is_verified = 1
        `).get(username.trim(), username.trim(), cleanedPassword);
        loginMethod = 'legacy_phone';
      }
    } else if (phone && nid) {
       // Phone + NID login (original method)
       // Clean phone input for consistency with validation/storage
       const cleanedPhone = phone.replace(/\D/g, '');
       user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(cleanedPhone, nid);
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
    const { phone } = req.body;
    if (phone) {
      const user = db.prepare('SELECT id FROM signups WHERE phone = ?').get(phone);
      if (user) logActivity('user_logout', user.id, null, null, req);
      db.prepare('UPDATE signups SET auth_token = NULL WHERE phone = ?').run(phone);
    }
    res.json({ success: true, message: 'Logged out' });
  });

  return router;
};
