const express = require('express');
const router = express.Router();

module.exports = function({ db, getSettings, logActivity, userAuth, getReferralPoints, sanitizeHTML, addTreasuryEntry, merit, notificationQueue }) {

  // POST /api/referral/introduce - Introduce a new member
  router.post('/api/referral/introduce', userAuth, (req, res) => {
    const { phone, nid, name, username, relation } = req.body;
    
    if (!phone || !nid || !relation) {
      return res.status(400).json({ 
        error: 'Phone, NID, and relation are required',
        success: false 
      });
    }
    
    // Validate relation
    const validRelations = ['family', 'friend', 'colleague', 'neighbor', 'other'];
    if (!validRelations.includes(relation)) {
      return res.status(400).json({ 
        error: 'Invalid relation. Choose from: family, friend, colleague, neighbor, other',
        success: false 
      });
    }
    
    try {
      // Check if user already exists
      const existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ? OR nid = ?').get(phone, nid);
      
      if (existing) {
        // Check if already referred by someone
        const existingReferral = db.prepare('SELECT id FROM referrals WHERE referred_id = ? AND status != ?').get(existing.id, 'removed');
        if (existingReferral) {
          return res.status(409).json({ 
            error: 'This person is already registered and has been introduced by another member',
            success: false 
          });
        }
        
        // Create referral for existing verified user (base reward only)
        const referrerId = req.user.id;
        
        // Count successful invites for this referrer
        const inviteCount = db.prepare(`
          SELECT COUNT(*) as count FROM referrals 
          WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given = 1
        `).get(referrerId).count;
        
        const basePoints = getReferralPoints(inviteCount + 1, false);
        
        const insertReferral = db.prepare(`
          INSERT INTO referrals (referrer_id, referred_id, relation, status, base_reward_given, created_at, referred_joined_at)
          VALUES (?, ?, ?, 'joined', ?, ?, ?)
        `);
        insertReferral.run(referrerId, existing.id, relation, basePoints, new Date().toISOString(), existing.timestamp);
        
        // Award merit to referrer
        merit.awardMerit(referrerId, 'referral_base', basePoints, existing.id, 'referral', `Referred existing member (${relation})`);

        // Log the activity
        logActivity('referral_created_existing', referrerId, existing.id, {
          relation,
          base_points_awarded: basePoints,
          referrer_invite_count: inviteCount + 1
        }, req);

        return res.json({
          success: true,
          message: `Member found! You earned ${basePoints} base points. They need to complete their first action for you to get the engagement bonus.`,
          points_earned: basePoints
        });
      }
      
      // Create pending referral for new user (will be activated on signup)
      const referrerId = req.user.id;
      
      const insertReferral = db.prepare(`
        INSERT INTO referrals (referrer_id, referred_id, relation, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
      `);
      // We'll need to store temp data - use negative ID to indicate pending
      const result = insertReferral.run(referrerId, 0, relation, new Date().toISOString());
      
      // Store pending referral data in a temp table or we can use the name/phone
      // For now, let's just mark it as pending and when user signs up with matching phone/nid, it will be linked
      
      // Actually, we should not create a pending referral this way. Instead, 
      // the person being introduced should use a referral code or we link by phone during signup.
      // Let me rethink this - we should create a temporary referral record that gets linked on signup.
      
      // Update: Let's create a temporary pending referral record with the phone/nid
      db.prepare(`
        UPDATE referrals SET status = 'pending_waiting', referred_id = NULL,
        details = ? WHERE id = ?
      `).run(JSON.stringify({ phone, nid }), result.lastInsertRowid);
      
      // Log the activity
      logActivity('referral_intro_initiated', referrerId, null, {
        relation,
        introduced_phone: phone.substring(0, 3) + 'xxx',
        introduced_nid: nid.substring(0, 2) + 'xxxxx'
      }, req);
      
      return res.json({
        success: true,
        message: `Invitation sent! When this person joins, you'll earn base points. Complete engagement earns bonus points.`,
        pending: true
      });
      
    } catch (error) {
      console.error('Referral error:', error);
      res.status(500).json({ error: 'Failed to create referral', success: false });
    }
  });

  // POST /api/enroll-family-friend - Enroll a family member or friend directly (optimized for logged-in users)
  router.post('/api/enroll-family-friend', userAuth, (req, res) => {
    const { name, username, email, island, contribution_types, donation_amount, relation } = req.body;
    // Normalize phone and nid: treat empty strings as null
    const phone = req.body.phone ? req.body.phone.trim() : null;
    const nid = req.body.nid ? req.body.nid.trim() : null;
    const referrerId = req.user.id;

    // Validate mandatory fields
    if (!relation) {
      return res.status(400).json({
        error: 'Relation is required',
        success: false
      });
    }

    // Validate relation
    const validRelations = ['family', 'friend', 'colleague', 'neighbor', 'other'];
    if (!validRelations.includes(relation)) {
      return res.status(400).json({
        error: 'Invalid relation. Choose from: family, friend, colleague, neighbor, other',
        success: false
      });
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
    }

    let cleanedPhone = null;
    if (phone) {
      // Basic phone validation (Maldivian format: 7 digits)
      const phoneRegex = /^[0-9]{7}$/;
      cleanedPhone = phone.replace(/\D/g, '');
      if (!phoneRegex.test(cleanedPhone)) {
        return res.status(400).json({
          error: 'Please enter a valid 7-digit phone number.',
          success: false
        });
      }
    }

    if (nid) {
      // Basic NID validation
      const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
      if (!nidRegex.test(nid)) {
        return res.status(400).json({
          error: 'Please enter a valid NID (e.g., A123456).',
          success: false
        });
      }
    }

    // Check for duplicate phone or NID only when provided
    if (cleanedPhone || nid) {
      let existing = null;
      if (cleanedPhone && nid) {
        existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ? OR nid = ?').get(cleanedPhone, nid);
      } else if (cleanedPhone) {
        existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ?').get(cleanedPhone);
      } else if (nid) {
        existing = db.prepare('SELECT id, is_verified FROM signups WHERE nid = ?').get(nid);
      }
      if (existing) {
        return res.status(409).json({
          error: 'This person is already registered with us.',
          success: false
        });
      }
    }

    // Calculate initial merit estimate
    const enrollSettings = getSettings();
    const meritEstimates = {
      'skills': enrollSettings.merit_skills,
      'action': enrollSettings.merit_action,
      'ideas': enrollSettings.merit_ideas,
      'donation': enrollSettings.merit_donation
    };
    let initialMerit = enrollSettings.signup_base_merit;
    typesArray.forEach(type => {
      initialMerit += meritEstimates[type] || 0;
    });
    initialMerit += Math.floor(Math.random() * enrollSettings.signup_random_bonus_max);

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
      if (enrollSettings.donation_formula === 'flat') {
        donationMerit = Math.floor(finalDonation / enrollSettings.donation_divisor_mvr) * enrollSettings.donation_bonus_per_100;
      } else {
        const amountUsd = finalDonation / enrollSettings.donation_usd_mvr_rate;
        donationMerit = Math.round(enrollSettings.donation_log_multiplier * Math.log(amountUsd + 1) / Math.log(5));
      }
      initialMerit += donationMerit;
    }

    try {
      const timestamp = new Date().toISOString();
      const contributionTypeJson = JSON.stringify(typesArray);

       // Create the new user
       const stmt = db.prepare(
         'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
         1,
         null,
         timestamp
       );

      // Count successful invites for this referrer
      const inviteCount = db.prepare(`
        SELECT COUNT(*) as count FROM referrals
        WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given = 1
      `).get(referrerId).count;

      const basePoints = getReferralPoints(inviteCount + 1, false);

      // Create referral record (already joined since we just created the user)
      const insertReferral = db.prepare(`
        INSERT INTO referrals (referrer_id, referred_id, relation, status, base_reward_given, created_at, referred_joined_at)
        VALUES (?, ?, ?, 'joined', ?, ?, ?)
      `);
      insertReferral.run(referrerId, result.lastInsertRowid, relation, basePoints, timestamp, timestamp);

      // Award points to referrer
      merit.awardMerit(referrerId, 'referral_base', basePoints, result.lastInsertRowid, 'referral', `Enrolled family/friend (${relation})`);

      // Log the activity
      logActivity('family_friend_enrolled', referrerId, result.lastInsertRowid, {
        relation,
        base_points_awarded: basePoints,
        referrer_invite_count: inviteCount + 1,
        enrolled_name: name || 'N/A'
      }, req);

      // Queue welcome notification for enrolled user
      const enrolledName = sanitizeHTML(name || username || 'A new member');
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
      const targetMembers = getSettings().target_members;
      const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
      try {
        if (notificationQueue) {
          notificationQueue.queueNotification({
            type: 'member_welcome',
            userId: result.lastInsertRowid,
            message: `🌴 ${enrolledName} just joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`
          });
        }
      } catch (e) {
        console.log('Could not queue welcome notification:', e.message);
      }

       res.status(201).json({
         success: true,
         message: `Successfully enrolled ${name || 'family member'}! You earned ${basePoints} base points. They need to complete their first action for you to get the engagement bonus.`,
         points_earned: basePoints,
         enrolled_user: {
           id: result.lastInsertRowid,
           phone: cleanedPhone,
           name: name || null,
           nid,
           email: email || null,
           username: username ? username.trim() : null,
           island: island || null,
           contribution_type: contributionTypeJson,
           donation_amount: finalDonation,
           initial_merit_estimate: initialMerit,
           timestamp
         }
       });

    } catch (error) {
      console.error('Enroll family/friend error:', error);
      res.status(500).json({
        error: 'Failed to enroll. Please try again.',
        success: false
      });
    }
  });

  // GET /api/referrals - Get user's referrals
  router.get('/api/referrals', userAuth, (req, res) => {
    try {
      const referrerId = req.user.id;
      
      const referrals = db.prepare(`
        SELECT r.*, s.name as referred_name, s.phone as referred_phone, s.island as referred_island
        FROM referrals r
        LEFT JOIN signups s ON r.referred_id = s.id
        WHERE r.referrer_id = ?
        ORDER BY r.created_at DESC
      `).all(referrerId);
      
      // Calculate total points earned
      const totals = db.prepare(`
        SELECT 
          COUNT(*) as total_referrals,
          SUM(base_reward_given) as total_base_points,
          SUM(engagement_bonus_given) as total_engagement_points
        FROM referrals 
        WHERE referrer_id = ? AND status != 'removed'
      `).get(referrerId);
      
      res.json({
        success: true,
        referrals: referrals.map(r => ({
          id: r.id,
          relation: r.relation,
          status: r.status,
          base_reward: r.base_reward_given,
          engagement_bonus: r.engagement_bonus_given,
          created_at: r.created_at,
          referred_joined_at: r.referred_joined_at,
          first_action_at: r.first_action_at,
          referred_name: r.referred_name,
          referred_phone: r.referred_phone ? r.referred_phone.substring(0, 3) + 'xxxx' : null
        })),
        summary: {
          total: totals.total_referrals || 0,
          base_points: totals.total_base_points || 0,
          engagement_points: totals.total_engagement_points || 0,
          total_points: (totals.total_base_points || 0) + (totals.total_engagement_points || 0)
        }
      });
    } catch (error) {
      console.error('Get referrals error:', error);
      res.status(500).json({ error: 'Failed to get referrals', success: false });
    }
  });

  // POST /api/referral/remove - Remove a referral (admin or user can request removal)
  router.post('/api/referral/remove', userAuth, (req, res) => {
    const { referral_id, reason } = req.body;
    
    if (!referral_id) {
      return res.status(400).json({ error: 'Referral ID required', success: false });
    }
    
    try {
      const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(referral_id);
      
      if (!referral) {
        return res.status(404).json({ error: 'Referral not found', success: false });
      }
      
      // Only referrer or admin can remove
      if (referral.referrer_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized', success: false });
      }
      
      // Check if points were already given - if so, reverse them
      if (referral.base_reward_given > 0 || referral.engagement_bonus_given > 0) {
        const pointsToReverse = referral.base_reward_given + referral.engagement_bonus_given;
        merit.awardMerit(referral.referrer_id, 'referral_removed', -pointsToReverse, referral.id, 'referral', `Referral removed: ${reason || 'User requested removal'}`);
      }
      
      // Mark as removed
      db.prepare("UPDATE referrals SET status = 'removed' WHERE id = ?").run(referral_id);
      
      // Log the activity
      logActivity('referral_removed', req.user.id, referral.referred_id, {
        reason: reason || 'User requested removal',
        points_reversed: referral.base_reward_given + referral.engagement_bonus_given
      }, req);
      
      res.json({ 
        success: true, 
        message: 'Referral removed. Any points have been reversed.',
        points_reversed: referral.base_reward_given + referral.engagement_bonus_given
      });
    } catch (error) {
      console.error('Remove referral error:', error);
      res.status(500).json({ error: 'Failed to remove referral', success: false });
    }
  });

  return router;
};
