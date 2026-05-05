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
            merit.awardMerit(original.created_by_user_id, 'bridge_building', bridgeBonus, proposal.id, 'proposal', 'Bridge-building bonus: Fixed failing proposal');
            maybeEngageReferral(original.created_by_user_id);
          }
        }

        const voters = queries.proposals.getVoters(proposal.id);
        voters.forEach(voter => {
          if (voter.user_id) {
            const points = passed ? settings.merit_vote_pass : settings.merit_vote_fail;
            const desc = passed ? 'Voted on passing proposal' : 'Voted on failing proposal';
            merit.awardMerit(voter.user_id, 'voting', points, proposal.id, 'proposal', desc);
            maybeEngageReferral(voter.user_id);
          }
        });

        if (proposal.created_by_user_id && passed) {
          const authorPoints = settings.merit_proposal_author;
          merit.awardMerit(proposal.created_by_user_id, 'proposal_author', authorPoints, proposal.id, 'proposal', 'Authored passing proposal');
          maybeEngageReferral(proposal.created_by_user_id);
        }

        merit.processProposalStakes(proposal.id, weighted_yes, weighted_no, total_weight);
      });
    } catch (e) {
      console.error('Close expired proposals error:', e);
    }
  };
};
