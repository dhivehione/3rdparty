const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, userAuth, getSettings, updateSettings }) {
  router.get('/api/leadership/settings', adminAuth, (req, res) => {
    try {
      const settings = db.prepare('SELECT * FROM leadership_settings WHERE id = 1').get();
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
      res.json({ success: true, settings, memberCount: memberCount.total });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch settings' });
    }
  });

  router.post('/api/leadership/settings', adminAuth, (req, res) => {
    const { member_threshold, min_merit_for_leadership, max_term_years, appraisal_frequency_days } = req.body;

    try {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE leadership_settings 
        SET member_threshold = ?, min_merit_for_leadership = ?, max_term_years = ?, appraisal_frequency_days = ?, updated_at = ?
        WHERE id = 1
      `).run(member_threshold || 1000, min_merit_for_leadership || 500, max_term_years || 2, appraisal_frequency_days || 365, now);

      res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not update settings' });
    }
  });

  router.get('/api/system-settings', adminAuth, (req, res) => {
    try {
      const settings = getSettings();
      res.json({ success: true, settings });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch system settings' });
    }
  });

  router.get('/api/public-settings', (req, res) => {
    try {
      const settings = getSettings();
      res.json({
        success: true,
        target_members: settings.target_members,
        target_treasury: settings.target_treasury,
        signup_base_merit: settings.signup_base_merit
      });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch public settings' });
    }
  });

  router.post('/api/system-settings', adminAuth, (req, res) => {
    try {
      const updated = updateSettings(req.body);
      res.json({ success: true, settings: updated });
    } catch (error) {
      console.error('System settings update error:', error);
      res.status(500).json({ success: false, error: 'Could not update system settings' });
    }
  });

  router.get('/api/leadership/positions', adminAuth, (req, res) => {
    try {
      const positions = db.prepare(`
        SELECT lp.*, 
          (SELECT COUNT(*) FROM leadership_terms WHERE position_id = lp.id AND ended_at IS NULL) as current_holders
        FROM leadership_positions lp
        ORDER BY lp.position_type, lp.id
      `).all();
      res.json({ success: true, positions });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch positions' });
    }
  });

  router.post('/api/leadership/positions', adminAuth, (req, res) => {
    const { title, description, position_type, min_merit_required } = req.body;

    if (!title || !position_type) {
      return res.status(400).json({ success: false, error: 'Title and type required' });
    }

    try {
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO leadership_positions (title, description, position_type, min_merit_required, is_active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(title, description || '', position_type, min_merit_required || 0, now);

      res.json({ success: true, message: 'Position created', id: result.lastInsertRowid });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not create position' });
    }
  });

  router.get('/api/leadership/applications', adminAuth, (req, res) => {
    try {
      const applications = db.prepare(`
        SELECT la.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title
        FROM leadership_applications la
        JOIN signups s ON la.user_id = s.id
        JOIN leadership_positions lp ON la.position_id = lp.id
        ORDER BY la.applied_at DESC
      `).all();
      res.json({ success: true, applications });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch applications' });
    }
  });

  router.post('/api/leadership/applications/:id/status', adminAuth, (req, res) => {
    const { status, interview_notes, interview_video_url } = req.body;
    const appId = parseInt(req.params.id);

    if (!['pending', 'interview', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    try {
      const interviewScheduled = status === 'interview' ? new Date().toISOString() : null;
      db.prepare(`
        UPDATE leadership_applications 
        SET status = ?, interview_scheduled_at = COALESCE(?, interview_scheduled_at), interview_notes = ?, interview_video_url = ?
        WHERE id = ?
      `).run(status, interviewScheduled, interview_notes || null, interview_video_url || null, appId);

      if (status === 'approved') {
        const app = db.prepare('SELECT user_id, position_id FROM leadership_applications WHERE id = ?').get(appId);
        if (app) {
          const now = new Date().toISOString();
          const existingTerm = db.prepare('SELECT MAX(term_number) as max_term FROM leadership_terms WHERE user_id = ? AND position_id = ?').get(app.user_id, app.position_id);
          const termNum = (existingTerm.max_term || 0) + 1;
          db.prepare('INSERT INTO leadership_terms (user_id, position_id, started_at, term_number) VALUES (?, ?, ?, ?)').run(app.user_id, app.position_id, now, termNum);
        }
      }

      res.json({ success: true, message: `Application ${status}` });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not update status' });
    }
  });

  router.get('/api/leadership/terms', adminAuth, (req, res) => {
    try {
      const terms = db.prepare(`
        SELECT lt.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title, lp.position_type
        FROM leadership_terms lt
        JOIN signups s ON lt.user_id = s.id
        JOIN leadership_positions lp ON lt.position_id = lp.id
        WHERE lt.ended_at IS NULL
        ORDER BY lt.started_at DESC
      `).all();
      res.json({ success: true, terms });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch terms' });
    }
  });

  router.post('/api/leadership/terms/:id/end', adminAuth, (req, res) => {
    const { reason } = req.body;
    const termId = parseInt(req.params.id);

    try {
      const now = new Date().toISOString();
      db.prepare('UPDATE leadership_terms SET ended_at = ? WHERE id = ?').run(now, termId);
      res.json({ success: true, message: 'Term ended' });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not end term' });
    }
  });

  router.get('/api/leadership/sops', adminAuth, (req, res) => {
    try {
      const sops = db.prepare('SELECT * FROM leadership_sops WHERE is_active = 1 ORDER BY category, title').all();
      res.json({ success: true, sops });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch SOPs' });
    }
  });

  router.post('/api/leadership/sops', adminAuth, (req, res) => {
    const { id, title, content, category } = req.body;
    const now = new Date().toISOString();

    try {
      if (id) {
        db.prepare('UPDATE leadership_sops SET title = ?, content = ?, category = ?, updated_at = ? WHERE id = ?').run(title, content, category || 'general', now, id);
        res.json({ success: true, message: 'SOP updated' });
      } else {
        const result = db.prepare('INSERT INTO leadership_sops (title, content, category, version, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)').run(title, content, category || 'general', now, now);
        res.json({ success: true, message: 'SOP created', id: result.lastInsertRowid });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not save SOP' });
    }
  });

  router.post('/api/leadership/appraisals', adminAuth, (req, res) => {
    const { term_id, appraisal_period, rating, strengths, areas_for_improvement, overall_feedback } = req.body;
    const now = new Date().toISOString();

    try {
      const result = db.prepare(`
        INSERT INTO leadership_appraisals (term_id, appraisal_period, rating, strengths, areas_for_improvement, overall_feedback, appraisal_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(term_id, appraisal_period, rating, strengths || '', areas_for_improvement || '', overall_feedback || '', now);

      res.json({ success: true, message: 'Appraisal recorded', id: result.lastInsertRowid });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not save appraisal' });
    }
  });

  router.get('/api/leadership/status', (req, res) => {
    try {
      const settings = db.prepare('SELECT member_threshold FROM leadership_settings WHERE id = 1').get();
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
      const activeTerms = db.prepare('SELECT COUNT(*) as total FROM leadership_terms WHERE ended_at IS NULL').get();
      const openPositions = db.prepare('SELECT COUNT(*) as total FROM leadership_positions WHERE is_active = 1').get();

      const thresholdMet = memberCount.total >= settings.member_threshold;

      res.json({
        success: true,
        threshold_met: thresholdMet,
        member_count: memberCount.total,
        threshold: settings.member_threshold,
        active_leaders: activeTerms.total,
        open_positions: openPositions.total
      });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch status' });
    }
  });

  router.post('/api/leadership/apply', userAuth, (req, res) => {
    const { position_id, application_text } = req.body;

    if (!position_id || !application_text) {
      return res.status(400).json({ success: false, error: 'Position and application text required' });
    }

    try {
      const settings = db.prepare('SELECT member_threshold, min_merit_for_leadership FROM leadership_settings WHERE id = 1').get();
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();

      if (memberCount.total < settings.member_threshold) {
        return res.status(400).json({ success: false, error: `Leadership applications open when membership reaches ${settings.member_threshold}. Currently: ${memberCount.total}` });
      }

      if (req.user.initial_merit_estimate < settings.min_merit_for_leadership) {
        return res.status(400).json({ success: false, error: `Minimum merit score of ${settings.min_merit_for_leadership} required. Your score: ${req.user.initial_merit_estimate}` });
      }

      const position = db.prepare('SELECT min_merit_required FROM leadership_positions WHERE id = ? AND is_active = 1').get(position_id);
      if (!position) {
        return res.status(400).json({ success: false, error: 'Position not found or closed' });
      }

      if (req.user.initial_merit_estimate < position.min_merit_required) {
        return res.status(400).json({ success: false, error: `This position requires ${position.min_merit_required} merit. Your score: ${req.user.initial_merit_estimate}` });
      }

      const existingApp = db.prepare('SELECT id FROM leadership_applications WHERE user_id = ? AND position_id = ? AND status != ?').get(req.user.id, position_id, 'rejected');
      if (existingApp) {
        return res.status(400).json({ success: false, error: 'You already have a pending application for this position' });
      }

      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO leadership_applications (user_id, position_id, application_text, status, merit_score_at_apply, applied_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(req.user.id, position_id, application_text, req.user.initial_merit_estimate, now);

      res.json({ success: true, message: 'Application submitted. Live interview will be scheduled.' });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not submit application' });
    }
  });

  router.get('/api/leadership/public', (req, res) => {
    try {
      const settings = db.prepare('SELECT member_threshold, min_merit_for_leadership FROM leadership_settings WHERE id = 1').get();
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();

      res.json({
        success: true,
        threshold_met: memberCount.total >= settings.member_threshold,
        member_count: memberCount.total,
        threshold: settings.member_threshold,
        min_merit: settings.min_merit_for_leadership
      });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch status' });
    }
  });

  router.get('/api/leadership/positions-public', (req, res) => {
    try {
      const positions = db.prepare(`
        SELECT id, title, description, position_type, min_merit_required
        FROM leadership_positions 
        WHERE is_active = 1
        ORDER BY position_type, id
      `).all();
      res.json({ success: true, positions });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch positions' });
    }
  });

  router.get('/api/leadership/terms-public', (req, res) => {
    try {
      const terms = db.prepare(`
        SELECT lt.id, lt.user_id, lt.started_at, lt.term_number,
          s.name, s.initial_merit_estimate as merit_score, 
          lp.title as position_title, lp.position_type
        FROM leadership_terms lt
        JOIN signups s ON lt.user_id = s.id
        JOIN leadership_positions lp ON lt.position_id = lp.id
        WHERE lt.ended_at IS NULL
        ORDER BY lt.started_at DESC
      `).all();
      res.json({ success: true, terms });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch terms' });
    }
  });

  router.get('/api/leadership/sops-public', (req, res) => {
    try {
      const sops = db.prepare(`
        SELECT id, title, content, category, version, updated_at
        FROM leadership_sops 
        WHERE is_active = 1
        ORDER BY category, title
      `).all();
      res.json({ success: true, sops });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not fetch SOPs' });
    }
  });

  return router;
};