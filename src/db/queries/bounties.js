module.exports = function(db) {
  return {
    createBounty(bounty) {
      return db.prepare('INSERT INTO bounties (title, description, tier, reward_points, posted_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(bounty.title, bounty.description, bounty.tier, bounty.reward_points, bounty.posted_by_user_id, bounty.created_at);
    },
    getBounties(statusFilter, tierFilter) {
      let query = `SELECT b.*, s.name as posted_by_name FROM bounties b JOIN signups s ON b.posted_by_user_id = s.id WHERE 1=1`;
      const params = [];
      if (statusFilter) { query += ' AND b.status = ?'; params.push(statusFilter); }
      if (tierFilter) { query += ' AND b.tier = ?'; params.push(tierFilter); }
      query += ' ORDER BY b.created_at DESC';
      return db.prepare(query).all(...params);
    },
    getBountyDetail(id) {
      return db.prepare(`SELECT b.*, s.name as posted_by_name, s.username as posted_by_username FROM bounties b JOIN signups s ON b.posted_by_user_id = s.id WHERE b.id = ?`).get(id);
    },
    getBountyClaims(bountyId) {
      return db.prepare(`SELECT bc.*, s.name as claimant_name, s.username as claimant_username FROM bounty_claims bc JOIN signups s ON bc.user_id = s.id WHERE bc.bounty_id = ? ORDER BY bc.created_at DESC`).all(bountyId);
    },
    getBounty(id) {
      return db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
    },
    getExistingClaim(bountyId, userId) {
      return db.prepare('SELECT id FROM bounty_claims WHERE bounty_id = ? AND user_id = ?').get(bountyId, userId);
    },
    createClaim(claim) {
      return db.prepare('INSERT INTO bounty_claims (bounty_id, user_id, proof, created_at) VALUES (?, ?, ?, ?)')
        .run(claim.bounty_id, claim.user_id, claim.proof, claim.created_at);
    },
    updateBountyStatus(id, status) {
      return db.prepare('UPDATE bounties SET status = ? WHERE id = ?').run(status, id);
    },
    updateBountyCompleted(id, assignedTo, completedAt) {
      return db.prepare('UPDATE bounties SET status = ?, assigned_to_user_id = ?, completed_at = ? WHERE id = ?').run('completed', assignedTo, completedAt, id);
    },
    getClaim(id, bountyId) {
      return db.prepare('SELECT * FROM bounty_claims WHERE id = ? AND bounty_id = ?').get(id, bountyId);
    },
    updateClaimApproved(id, reviewerId, reviewedAt) {
      return db.prepare('UPDATE bounty_claims SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?').run('approved', reviewerId, reviewedAt, id);
    },
    updateClaimRejected(id, reviewerId, reviewedAt) {
      return db.prepare('UPDATE bounty_claims SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?').run('rejected', reviewerId, reviewedAt, id);
    },
    countPendingClaims(bountyId) {
      return db.prepare("SELECT COUNT(*) as cnt FROM bounty_claims WHERE bounty_id = ? AND status = 'pending'").get(bountyId);
    },
    updateBountyOpen(id) {
      return db.prepare("UPDATE bounties SET status = 'open' WHERE id = ?").run(id);
    },
    updateBountyCancelled(id) {
      return db.prepare("UPDATE bounties SET status = 'cancelled' WHERE id = ?").run(id);
    },
    getUserPostedBounties(userId) {
      return db.prepare('SELECT b.*, s.name as posted_by_name FROM bounties b JOIN signups s ON b.posted_by_user_id = s.id WHERE b.posted_by_user_id = ? ORDER BY b.created_at DESC').all(userId);
    },
    getUserClaimedBounties(userId) {
      return db.prepare('SELECT bc.*, b.title, b.tier, b.reward_points FROM bounty_claims bc JOIN bounties b ON bc.bounty_id = b.id WHERE bc.user_id = ? ORDER BY bc.created_at DESC').all(userId);
    },
    getAcademyModules() {
      return db.prepare('SELECT * FROM academy_modules WHERE is_active = 1 ORDER BY order_index').all();
    },
    getAcademyModule(id) {
      return db.prepare('SELECT * FROM academy_modules WHERE id = ? AND is_active = 1').get(id);
    },
    getExistingEnrollment(userId, moduleId) {
      return db.prepare('SELECT id FROM academy_enrollments WHERE user_id = ? AND module_id = ?').get(userId, moduleId);
    },
    createEnrollment(userId, moduleId, enrolledAt) {
      return db.prepare('INSERT INTO academy_enrollments (user_id, module_id, enrolled_at) VALUES (?, ?, ?)').run(userId, moduleId, enrolledAt);
    },
    getEnrollment(userId, moduleId) {
      return db.prepare('SELECT * FROM academy_enrollments WHERE user_id = ? AND module_id = ?').get(userId, moduleId);
    },
    updateEnrollmentCompleted(id, status, completedAt) {
      return db.prepare('UPDATE academy_enrollments SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id);
    },
    countAcademyModules() {
      return db.prepare('SELECT COUNT(*) as total FROM academy_modules WHERE is_active = 1').get().total;
    },
    countCompletedModules(userId) {
      return db.prepare("SELECT COUNT(*) as completed FROM academy_enrollments WHERE user_id = ? AND status = 'completed'").get(userId);
    },
    getGraduation(userId) {
      return db.prepare('SELECT id FROM academy_graduation WHERE user_id = ?').get(userId);
    },
    createGraduation(userId, graduatedAt, meritAwarded) {
      return db.prepare('INSERT INTO academy_graduation (user_id, graduated_at, merit_awarded) VALUES (?, ?, ?)').run(userId, graduatedAt, meritAwarded);
    },
    getUserEnrollments(userId) {
      return db.prepare('SELECT * FROM academy_enrollments WHERE user_id = ?').all(userId);
    },
    getGraduationDetail(userId) {
      return db.prepare('SELECT * FROM academy_graduation WHERE user_id = ?').get(userId);
    },
    getUserStipends(userId) {
      return db.prepare(`SELECT ls.*, lp.title as position_title, lp.position_type FROM leadership_stipends ls JOIN leadership_positions lp ON ls.position_id = lp.id WHERE ls.user_id = ? ORDER BY ls.period_year DESC, ls.period_month DESC`).all(userId);
    },
    insertAdvisoryReport(report) {
      return db.prepare('INSERT INTO advisory_reports (user_id, report_title, report_content, created_at) VALUES (?, ?, ?, ?)')
        .run(report.user_id, report.report_title, report.report_content, report.created_at);
    },
    getUserReports(userId) {
      return db.prepare('SELECT * FROM advisory_reports WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    },
    getReport(id) {
      return db.prepare('SELECT * FROM advisory_reports WHERE id = ?').get(id);
    },
    updateReportApproved(id, reviewerId, reviewedAt) {
      return db.prepare('UPDATE advisory_reports SET status = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?').run('approved', reviewerId, reviewedAt, id);
    },
  };
};
