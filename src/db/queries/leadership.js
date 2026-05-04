module.exports = function(db) {
  return {
    getSettings() {
      return db.prepare('SELECT * FROM leadership_settings WHERE id = 1').get();
    },
    updateSettings(settings) {
      return db.prepare('UPDATE leadership_settings SET member_threshold = ?, min_merit_for_leadership = ?, max_term_years = ?, appraisal_frequency_days = ?, updated_at = ? WHERE id = 1')
        .run(settings.member_threshold, settings.min_merit_for_leadership, settings.max_term_years, settings.appraisal_frequency_days, settings.updated_at);
    },
    getPositions() {
      return db.prepare(`
        SELECT lp.*, (SELECT COUNT(*) FROM leadership_terms WHERE position_id = lp.id AND ended_at IS NULL) as current_holders
        FROM leadership_positions lp ORDER BY lp.position_type, lp.id
      `).all();
    },
    insertPosition(position) {
      return db.prepare('INSERT INTO leadership_positions (title, description, position_type, min_merit_required, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(position.title, position.description, position.position_type, position.min_merit_required, position.is_active, position.created_at);
    },
    getApplications() {
      return db.prepare(`
        SELECT la.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title
        FROM leadership_applications la JOIN signups s ON la.user_id = s.id JOIN leadership_positions lp ON la.position_id = lp.id
        ORDER BY la.applied_at DESC
      `).all();
    },
    updateApplicationStatus(id, status, interviewScheduledAt, interviewNotes, interviewVideoUrl) {
      return db.prepare('UPDATE leadership_applications SET status = ?, interview_scheduled_at = COALESCE(?, interview_scheduled_at), interview_notes = ?, interview_video_url = ? WHERE id = ?')
        .run(status, interviewScheduledAt, interviewNotes, interviewVideoUrl, id);
    },
    getApplication(id) {
      return db.prepare('SELECT user_id, position_id FROM leadership_applications WHERE id = ?').get(id);
    },
    getMaxTerm(userId, positionId) {
      return db.prepare('SELECT MAX(term_number) as max_term FROM leadership_terms WHERE user_id = ? AND position_id = ?').get(userId, positionId);
    },
    insertTerm(term) {
      return db.prepare('INSERT INTO leadership_terms (user_id, position_id, started_at, term_number) VALUES (?, ?, ?, ?)')
        .run(term.user_id, term.position_id, term.started_at, term.term_number);
    },
    getActiveTerms() {
      return db.prepare(`
        SELECT lt.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title, lp.position_type
        FROM leadership_terms lt JOIN signups s ON lt.user_id = s.id JOIN leadership_positions lp ON lt.position_id = lp.id
        WHERE lt.ended_at IS NULL ORDER BY lt.started_at DESC
      `).all();
    },
    endTerm(id, endedAt) {
      return db.prepare('UPDATE leadership_terms SET ended_at = ? WHERE id = ?').run(endedAt, id);
    },
    getSOPs() {
      return db.prepare('SELECT * FROM leadership_sops WHERE is_active = 1 ORDER BY category, title').all();
    },
    updateSOP(id, title, content, category, updatedAt) {
      return db.prepare('UPDATE leadership_sops SET title = ?, content = ?, category = ?, updated_at = ? WHERE id = ?')
        .run(title, content, category, updatedAt, id);
    },
    insertSOP(sop) {
      return db.prepare('INSERT INTO leadership_sops (title, content, category, version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sop.title, sop.content, sop.category, sop.version, sop.is_active, sop.created_at, sop.updated_at);
    },
    insertAppraisal(appraisal) {
      return db.prepare('INSERT INTO leadership_appraisals (term_id, appraisal_period, rating, strengths, areas_for_improvement, overall_feedback, appraisal_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(appraisal.term_id, appraisal.appraisal_period, appraisal.rating, appraisal.strengths, appraisal.areas_for_improvement, appraisal.overall_feedback, appraisal.appraisal_by_user_id, appraisal.created_at);
    },
    getActiveTermsCount() {
      return db.prepare('SELECT COUNT(*) as total FROM leadership_terms WHERE ended_at IS NULL').get().total;
    },
    getOpenPositionsCount() {
      return db.prepare('SELECT COUNT(*) as total FROM leadership_positions WHERE is_active = 1').get().total;
    },
    getPosition(id) {
      return db.prepare('SELECT min_merit_required FROM leadership_positions WHERE id = ? AND is_active = 1').get(id);
    },
    getExistingApplication(userId, positionId) {
      return db.prepare("SELECT id FROM leadership_applications WHERE user_id = ? AND position_id = ? AND status != 'rejected'").get(userId, positionId);
    },
  };
};
