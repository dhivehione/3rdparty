module.exports = function({ queries, getSettings, merit, maybeEngageReferral }) {
  return function closeExpiredProposals() {
    try {
      const settings = getSettings();
      const expiredProposals = queries.proposals.getExpired();

      expiredProposals.forEach(proposal => {
        const weightedCounts = queries.proposals.getVoteCountsForClose(proposal.id);

        const weighted_yes = weightedCounts?.weighted_yes || 0;
        const weighted_no = weightedCounts?.weighted_no || 0;
        const raw_yes = weightedCounts?.raw_yes || 0;
        const raw_no = weightedCounts?.raw_no || 0;
        const raw_abstain = weightedCounts?.raw_abstain || 0;

        const threshold = merit.calculateApprovalThreshold(proposal.category);
        const total_weight = weighted_yes + weighted_no;
        const passed = total_weight > 0 && (weighted_yes / total_weight) >= threshold;

        queries.proposals.close(proposal.id, passed, weighted_yes, weighted_no, raw_abstain);

        if (passed && proposal.amendment_of) {
          const original = queries.proposals.getOriginal(proposal.amendment_of);
          if (original && original.created_by_user_id) {
            const bridgeBonus = settings.bridge_building_bonus;
            queries.merit.insertEvent({
              user_id: proposal.created_by_user_id, event_type: 'bridge_building', points: bridgeBonus,
              reference_id: proposal.id, reference_type: 'proposal',
              description: 'Bridge-building bonus: Fixed failing proposal', created_at: new Date().toISOString()
            });
            queries.signups.updateMerit(proposal.created_by_user_id, bridgeBonus);
          }
        }

        const voters = queries.proposals.getVoters(proposal.id);
        voters.forEach(voter => {
          if (voter.user_id) {
            const points = passed ? settings.merit_vote_pass : settings.merit_vote_fail;
            const desc = passed ? 'Voted on passing proposal' : 'Voted on failing proposal';
            queries.merit.insertEvent({
              user_id: voter.user_id, event_type: 'voting', points,
              reference_id: proposal.id, reference_type: 'proposal',
              description: desc, created_at: new Date().toISOString()
            });
            queries.signups.updateMerit(voter.user_id, points);
            maybeEngageReferral(voter.user_id);
          }
        });

        if (proposal.created_by_user_id && passed) {
          const authorPoints = settings.merit_proposal_author;
          queries.merit.insertEvent({
            user_id: proposal.created_by_user_id, event_type: 'proposal_author', points: authorPoints,
            reference_id: proposal.id, reference_type: 'proposal',
            description: 'Authored passing proposal', created_at: new Date().toISOString()
          });
          queries.signups.updateMerit(proposal.created_by_user_id, authorPoints);
        }

        merit.processProposalStakes(proposal.id, weighted_yes, weighted_no, total_weight);
      });
    } catch (e) {
      console.error('Close expired proposals error:', e);
    }
  };
};
