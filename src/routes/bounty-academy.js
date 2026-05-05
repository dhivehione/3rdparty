const express = require('express');
const router = express.Router();
function getBountyReward(settings, tier) {
  const map = {
    1: settings.bounty_tier1_reward,
    2: settings.bounty_tier2_reward,
    3: settings.bounty_tier3_reward
  };
  return map[tier] || 0;
}

module.exports = function({ db, userAuth, logActivity, getSettings, merit }) {
  // ==================== BOUNTY SYSTEM ====================
  router.post('/api/bounties', userAuth, (req, res) => {
    const { title, description, tier } = req.body;

    if (!title || title.trim().length < 5) {
      return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
    }
    if (!description || description.trim().length < 20) {
      return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
    }
    if (![1, 2, 3].includes(parseInt(tier))) {
      return res.status(400).json({ error: 'Tier must be 1, 2, or 3', success: false });
    }

    try {
      const tierNum = parseInt(tier);
      const rewardPoints = getBountyReward(getSettings(), tierNum);
      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO bounties (title, description, tier, reward_points, posted_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(title.trim(), description.trim(), tierNum, rewardPoints, req.user.id, now);

      logActivity('bounty_created', req.user.id, result.lastInsertRowid, { title: title.trim(), tier: tierNum }, req);
      res.status(201).json({ success: true, message: 'Bounty posted', bounty_id: result.lastInsertRowid });
    } catch (error) {
      console.error('Bounty create error:', error);
      res.status(500).json({ error: 'Could not create bounty', success: false });
    }
  });

  router.get('/api/bounties', (req, res) => {
    const { status, tier } = req.query;

    try {
      let query = 'SELECT b.*, s.name as posted_by_name FROM bounties b JOIN signups s ON b.posted_by_user_id = s.id WHERE 1=1';
      const params = [];

      if (status) {
        query += ' AND b.status = ?';
        params.push(status);
      }
      if (tier) {
        query += ' AND b.tier = ?';
        params.push(parseInt(tier));
      }

      query += ' ORDER BY b.created_at DESC';

      const bounties = db.prepare(query).all(...params);
      res.json({ success: true, bounties });
    } catch (error) {
      console.error('Get bounties error:', error);
      res.status(500).json({ error: 'Could not fetch bounties', success: false });
    }
  });

  router.get('/api/bounties/:id', (req, res) => {
    const { id } = req.params;

    try {
      const bounty = db.prepare(`
        SELECT b.*, s.name as posted_by_name, s.username as posted_by_username
        FROM bounties b
        JOIN signups s ON b.posted_by_user_id = s.id
        WHERE b.id = ?
      `).get(id);

      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found', success: false });
      }

      const claims = db.prepare(`
        SELECT bc.*, s.name as claimant_name, s.username as claimant_username
        FROM bounty_claims bc
        JOIN signups s ON bc.user_id = s.id
        WHERE bc.bounty_id = ?
        ORDER BY bc.created_at DESC
      `).all(id);

      res.json({ success: true, bounty, claims });
    } catch (error) {
      console.error('Get bounty error:', error);
      res.status(500).json({ error: 'Could not fetch bounty', success: false });
    }
  });

  router.post('/api/bounties/:id/claim', userAuth, (req, res) => {
    const { id } = req.params;
    const { proof } = req.body;

    if (!proof || proof.trim().length < 10) {
      return res.status(400).json({ error: 'Proof description must be at least 10 characters', success: false });
    }

    try {
      const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found', success: false });
      }
      if (bounty.status !== 'open') {
        return res.status(400).json({ error: 'Bounty is not open for claims', success: false });
      }

      const existing = db.prepare('SELECT id FROM bounty_claims WHERE bounty_id = ? AND user_id = ?').get(id, req.user.id);
      if (existing) {
        return res.status(409).json({ error: 'You have already claimed this bounty', success: false });
      }

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO bounty_claims (bounty_id, user_id, proof, created_at)
        VALUES (?, ?, ?, ?)
      `).run(id, req.user.id, proof.trim(), now);

      db.prepare('UPDATE bounties SET status = ? WHERE id = ?').run('in_progress', id);

      logActivity('bounty_claimed', req.user.id, id, { bounty_id: id }, req);
      res.json({ success: true, message: 'Bounty claim submitted' });
    } catch (error) {
      console.error('Bounty claim error:', error);
      res.status(500).json({ error: 'Could not claim bounty', success: false });
    }
  });

  router.post('/api/bounties/:id/approve', userAuth, (req, res) => {
    const { id } = req.params;
    const { claim_id } = req.body;

    try {
      const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found', success: false });
      }

      const claim = db.prepare('SELECT * FROM bounty_claims WHERE id = ? AND bounty_id = ?').get(claim_id, id);
      if (!claim) {
        return res.status(404).json({ error: 'Claim not found', success: false });
      }

      db.prepare('UPDATE bounty_claims SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?')
        .run('approved', req.user.id, new Date().toISOString(), claim_id);

      db.prepare('UPDATE bounties SET status = ?, assigned_to_user_id = ?, completed_at = ? WHERE id = ?')
        .run('completed', claim.user_id, new Date().toISOString(), id);

      const desc = `Completed bounty: ${bounty.title}`;
      merit.awardMerit(claim.user_id, 'bounty', bounty.reward_points, id, 'bounty', desc);

      logActivity('bounty_completed', claim.user_id, id, { bounty_id: id, points: bounty.reward_points }, req);
      res.json({ success: true, message: 'Bounty approved and points awarded' });
    } catch (error) {
      console.error('Approve bounty error:', error);
      res.status(500).json({ error: 'Could not approve bounty', success: false });
    }
  });

  router.post('/api/bounties/:id/reject', userAuth, (req, res) => {
    const { id } = req.params;
    const { claim_id, reason } = req.body;

    try {
      db.prepare('UPDATE bounty_claims SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?')
        .run('rejected', req.user.id, new Date().toISOString(), claim_id);

      const remainingClaims = db.prepare("SELECT COUNT(*) as cnt FROM bounty_claims WHERE bounty_id = ? AND status = 'pending'").get(id);
      if (remainingClaims.cnt === 0) {
        db.prepare("UPDATE bounties SET status = 'open' WHERE id = ?").run(id);
      }

      res.json({ success: true, message: 'Claim rejected' });
    } catch (error) {
      console.error('Reject bounty error:', error);
      res.status(500).json({ error: 'Could not reject claim', success: false });
    }
  });

  router.post('/api/bounties/:id/cancel', userAuth, (req, res) => {
    const { id } = req.params;

    try {
      const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found', success: false });
      }
      if (bounty.posted_by_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Only the poster can cancel', success: false });
      }
      if (bounty.status === 'completed') {
        return res.status(400).json({ error: 'Cannot cancel completed bounty', success: false });
      }

      db.prepare("UPDATE bounties SET status = 'cancelled' WHERE id = ?").run(id);
      res.json({ success: true, message: 'Bounty cancelled' });
    } catch (error) {
      console.error('Cancel bounty error:', error);
      res.status(500).json({ error: 'Could not cancel bounty', success: false });
    }
  });

  router.get('/api/user/bounties', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const posted = db.prepare(`
        SELECT b.*, s.name as posted_by_name FROM bounties b
        JOIN signups s ON b.posted_by_user_id = s.id
        WHERE b.posted_by_user_id = ?
        ORDER BY b.created_at DESC
      `).all(userId);

      const claimed = db.prepare(`
        SELECT bc.*, b.title, b.tier, b.reward_points
        FROM bounty_claims bc
        JOIN bounties b ON bc.bounty_id = b.id
        WHERE bc.user_id = ?
        ORDER BY bc.created_at DESC
      `).all(userId);

      res.json({ success: true, posted, claimed });
    } catch (error) {
      console.error('Get user bounties error:', error);
      res.status(500).json({ error: 'Could not fetch bounties', success: false });
    }
  });

  // ==================== LEADERSHIP ACADEMY ====================
  router.get('/api/academy/modules', (req, res) => {
    try {
      const modules = db.prepare('SELECT * FROM academy_modules WHERE is_active = 1 ORDER BY order_index').all();
      res.json({ success: true, modules });
    } catch (error) {
      console.error('Get modules error:', error);
      res.status(500).json({ error: 'Could not fetch modules', success: false });
    }
  });

  router.post('/api/academy/enroll', userAuth, (req, res) => {
    const { module_id } = req.body;
    const userId = req.user.id;

    if (!module_id) {
      return res.status(400).json({ error: 'module_id required', success: false });
    }

    try {
      const module = db.prepare('SELECT * FROM academy_modules WHERE id = ? AND is_active = 1').get(module_id);
      if (!module) {
        return res.status(404).json({ error: 'Module not found', success: false });
      }

      const existing = db.prepare('SELECT id FROM academy_enrollments WHERE user_id = ? AND module_id = ?').get(userId, module_id);
      if (existing) {
        return res.status(409).json({ error: 'Already enrolled in this module', success: false });
      }

      const now = new Date().toISOString();
      db.prepare('INSERT INTO academy_enrollments (user_id, module_id, enrolled_at) VALUES (?, ?, ?)').run(userId, module_id, now);

      logActivity('academy_enroll', userId, module_id, { module: module.title }, req);
      res.json({ success: true, message: 'Enrolled in module' });
    } catch (error) {
      console.error('Academy enroll error:', error);
      res.status(500).json({ error: 'Could not enroll', success: false });
    }
  });

  router.post('/api/academy/complete', userAuth, (req, res) => {
    const { module_id } = req.body;
    const userId = req.user.id;

    if (!module_id) {
      return res.status(400).json({ error: 'module_id required', success: false });
    }

    try {
      const enrollment = db.prepare('SELECT * FROM academy_enrollments WHERE user_id = ? AND module_id = ?').get(userId, module_id);
      if (!enrollment) {
        return res.status(404).json({ error: 'Not enrolled in this module', success: false });
      }
      if (enrollment.status === 'completed') {
        return res.status(400).json({ error: 'Module already completed', success: false });
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE academy_enrollments SET status = ?, completed_at = ? WHERE id = ?').run('completed', now, enrollment.id);

      const allModules = db.prepare('SELECT COUNT(*) as total FROM academy_modules WHERE is_active = 1').get();
      const completedModules = db.prepare("SELECT COUNT(*) as completed FROM academy_enrollments WHERE user_id = ? AND status = 'completed'").get(userId);

      if (completedModules.completed >= allModules.total) {
        const gradExists = db.prepare('SELECT id FROM academy_graduation WHERE user_id = ?').get(userId);
        if (!gradExists) {
          const graduationMerit = getSettings().academy_graduation_merit;
          const gradNow = new Date().toISOString();
          db.prepare('INSERT INTO academy_graduation (user_id, graduated_at, merit_awarded) VALUES (?, ?, ?)').run(userId, gradNow, graduationMerit);

          merit.awardMerit(userId, 'academy_graduation', graduationMerit, null, 'academy', 'Leadership Academy graduation (Tier 3 Bounty)');

          logActivity('academy_graduation', userId, null, { merit: graduationMerit }, req);
          return res.json({ success: true, message: 'Module completed! Congratulations on graduating from the Leadership Academy!', graduated: true });
        }
      }

      res.json({ success: true, message: 'Module completed', graduated: false });
    } catch (error) {
      console.error('Academy complete error:', error);
      res.status(500).json({ error: 'Could not complete module', success: false });
    }
  });

  router.get('/api/academy/progress', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const modules = db.prepare('SELECT * FROM academy_modules WHERE is_active = 1 ORDER BY order_index').all();
      const enrollments = db.prepare('SELECT * FROM academy_enrollments WHERE user_id = ?').all(userId);

      const progress = modules.map(m => {
        const enrollment = enrollments.find(e => e.module_id === m.id);
        return {
          ...m,
          status: enrollment ? enrollment.status : 'not_enrolled',
          enrolled_at: enrollment ? enrollment.enrolled_at : null,
          completed_at: enrollment ? enrollment.completed_at : null
        };
      });

      const completed = progress.filter(p => p.status === 'completed').length;
      const graduation = db.prepare('SELECT * FROM academy_graduation WHERE user_id = ?').get(userId);

      res.json({ success: true, progress, completed_count: completed, total_modules: modules.length, graduated: !!graduation, graduation_date: graduation ? graduation.graduated_at : null });
    } catch (error) {
      console.error('Academy progress error:', error);
      res.status(500).json({ error: 'Could not fetch progress', success: false });
    }
  });

  // ==================== STIPENDS ====================
  router.get('/api/stipends', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const stipends = db.prepare(`
        SELECT ls.*, lp.title as position_title, lp.position_type
        FROM leadership_stipends ls
        JOIN leadership_positions lp ON ls.position_id = lp.id
        WHERE ls.user_id = ?
        ORDER BY ls.period_year DESC, ls.period_month DESC
      `).all(userId);

      res.json({ success: true, stipends });
    } catch (error) {
      console.error('Get stipends error:', error);
      res.status(500).json({ error: 'Could not fetch stipends', success: false });
    }
  });

  // ==================== ADVISORY REPORTS ====================
  router.post('/api/advisory-reports', userAuth, (req, res) => {
    const { report_title, report_content } = req.body;
    const userId = req.user.id;

    if (!report_title || report_title.trim().length < 5) {
      return res.status(400).json({ error: 'Report title must be at least 5 characters', success: false });
    }

    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO advisory_reports (user_id, report_title, report_content, created_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, report_title.trim(), report_content ? report_content.trim() : '', now);

      logActivity('advisory_report_submitted', userId, null, { title: report_title.trim() }, req);
      res.status(201).json({ success: true, message: 'Advisory report submitted' });
    } catch (error) {
      console.error('Submit report error:', error);
      res.status(500).json({ error: 'Could not submit report', success: false });
    }
  });

  router.get('/api/advisory-reports', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const reports = db.prepare(`
        SELECT * FROM advisory_reports WHERE user_id = ? ORDER BY created_at DESC
      `).all(userId);

      res.json({ success: true, reports });
    } catch (error) {
      console.error('Get reports error:', error);
      res.status(500).json({ error: 'Could not fetch reports', success: false });
    }
  });

  router.post('/api/advisory-reports/:id/approve', userAuth, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
      const report = db.prepare('SELECT * FROM advisory_reports WHERE id = ?').get(id);
      if (!report) {
        return res.status(404).json({ error: 'Report not found', success: false });
      }
      if (report.status !== 'pending') {
        return res.status(400).json({ error: 'Report already reviewed', success: false });
      }

      db.prepare('UPDATE advisory_reports SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?')
        .run('approved', userId, new Date().toISOString(), id);

      merit.awardMerit(report.user_id, 'advisory_report', getSettings().stipend_advisory, id, 'advisory_report', `Advisory report: ${report.report_title}`);

      logActivity('advisory_report_approved', report.user_id, id, { points: getSettings().stipend_advisory }, req);
      res.json({ success: true, message: 'Report approved and points awarded' });
    } catch (error) {
      console.error('Approve report error:', error);
      res.status(500).json({ error: 'Could not approve report', success: false });
    }
  });

  return router;
};