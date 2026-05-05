module.exports = function(db) {
  return {
    getActive() {
      return db.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count,
          (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'yes') as weighted_yes,
          (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'no') as weighted_no,
          (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'abstain') as weighted_abstain
        FROM proposals p
        WHERE p.status = 'active'
        ORDER BY p.created_at DESC
      `).all();
    },
    getAll() {
      return db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count
        FROM proposals p ORDER BY p.created_at DESC
      `).all();
    },
    getById(id) {
      return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    },
    getExpired() {
      return db.prepare(`
        SELECT id, created_by_user_id, amendment_of, category, yes_votes, no_votes FROM proposals
        WHERE status = 'active' AND is_closed = 0 AND datetime(ends_at) <= datetime('now')
      `).all();
    },
    getLastCreatedByUser(userId) {
      return db.prepare('SELECT created_at FROM proposals WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
    },
    getVoteTally(proposalId) {
      return db.prepare(`
        SELECT choice, SUM(vote_weight) as weighted_cnt, COUNT(*) as raw_cnt
        FROM votes WHERE proposal_id = ? GROUP BY choice
      `).all(proposalId);
    },
    getVoteCountsForClose(proposalId) {
      return db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN choice = 'yes' THEN vote_weight ELSE 0 END), 0) as weighted_yes,
          COALESCE(SUM(CASE WHEN choice = 'no' THEN vote_weight ELSE 0 END), 0) as weighted_no,
          SUM(CASE WHEN choice = 'yes' THEN 1 ELSE 0 END) as raw_yes,
          SUM(CASE WHEN choice = 'no' THEN 1 ELSE 0 END) as raw_no,
          SUM(CASE WHEN choice = 'abstain' THEN 1 ELSE 0 END) as raw_abstain
        FROM votes WHERE proposal_id = ?
      `).get(proposalId);
    },
    getVoters(proposalId) {
      return db.prepare('SELECT user_id FROM votes WHERE proposal_id = ? AND choice != ?').all(proposalId, 'abstain');
    },
    getUserVotes(userId) {
      return db.prepare('SELECT proposal_id, choice FROM votes WHERE user_id = ?').all(userId);
    },
    getIPVotes(ip) {
      return db.prepare('SELECT proposal_id, choice FROM votes WHERE voter_ip = ?').all(ip);
    },
    getExistingVote(proposalId, ip) {
      return db.prepare('SELECT id, user_id FROM votes WHERE proposal_id = ? AND voter_ip = ?').get(proposalId, ip);
    },
    countByStatus(status) {
      return db.prepare('SELECT COUNT(*) as total FROM proposals WHERE status = ?').get(status).total;
    },
    countVotes() {
      return db.prepare('SELECT COUNT(*) as total FROM votes').get().total;
    },
    countOpen() {
      return db.prepare("SELECT COUNT(*) as total FROM proposals WHERE status = 'active' AND datetime(ends_at) > datetime('now')").get().total;
    },
    create(proposal) {
      return db.prepare(
        'INSERT INTO proposals (title, description, category, created_by_nickname, created_at, ends_at, created_by_user_id, approval_threshold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(proposal.title, proposal.description, proposal.category, proposal.created_by_nickname, proposal.created_at, proposal.ends_at, proposal.created_by_user_id, proposal.approval_threshold);
    },
    updateVote(vote) {
      return db.prepare(
        'UPDATE votes SET choice = ?, voted_at = ?, user_id = ?, vote_weight = ?, loyalty_coefficient = ?, days_since_created = ? WHERE id = ?'
      ).run(vote.choice, vote.voted_at, vote.user_id, vote.vote_weight, vote.loyalty_coefficient, vote.days_since_created, vote.id);
    },
    insertVote(vote) {
      return db.prepare(
        'INSERT INTO votes (proposal_id, choice, voter_ip, voted_at, user_id, vote_weight, loyalty_coefficient, days_since_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(vote.proposal_id, vote.choice, vote.voter_ip, vote.voted_at, vote.user_id, vote.vote_weight, vote.loyalty_coefficient, vote.days_since_created);
    },
    updateTallies(id, yesVotes, noVotes, abstainVotes) {
      return db.prepare('UPDATE proposals SET yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?').run(yesVotes, noVotes, abstainVotes, id);
    },
    update(id, updates) {
      return db.prepare(`UPDATE proposals SET ${updates.join(', ')} WHERE id = ?`);
    },
    updateAdmin(id, title, description, category, updatedAt) {
      return db.prepare('UPDATE proposals SET title = ?, description = ?, category = ?, updated_at = ? WHERE id = ?').run(title, description, category, updatedAt, id);
    },
    updateStatus(id, status, updatedAt) {
      return db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
    },
    close(proposalId, passed, weightedYes, weightedNo, rawAbstain) {
      return db.prepare('UPDATE proposals SET is_closed = 1, passed = ?, yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?')
        .run(passed ? 1 : 0, weightedYes, weightedNo, rawAbstain, proposalId);
    },
    getOriginal(amendmentOf) {
      return db.prepare('SELECT id, created_by_user_id FROM proposals WHERE id = ?').get(amendmentOf);
    },
    getStakes(proposalId) {
      return db.prepare('SELECT ps.*, s.name, s.username FROM proposal_stakes ps JOIN signups s ON ps.user_id = s.id WHERE ps.proposal_id = ?').all(proposalId);
    },
    getExistingStake(proposalId, userId) {
      return db.prepare('SELECT id FROM proposal_stakes WHERE proposal_id = ? AND user_id = ?').get(proposalId, userId);
    },
    createStake(stake) {
      return db.prepare('INSERT INTO proposal_stakes (proposal_id, user_id, stake_amount, created_at) VALUES (?, ?, ?, ?)')
        .run(stake.proposal_id, stake.user_id, stake.stake_amount, stake.created_at);
    },
  };
};
