module.exports = function({ queries }) {
  return function processHubStipends() {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const HUB_STIPEND = 50;
      const activeHubs = queries.hubs.getActiveHubsForStipends();
      activeHubs.forEach(hub => {
        const members = queries.hubs.getHubMembersForStipends(hub.id);
        members.forEach(member => {
          const existing = queries.hubs.getExistingHubStipend(hub.id, member.user_id, year, month);
          if (!existing) {
            const awardedAt = now.toISOString();
            queries.hubs.insertHubStipend(hub.id, member.user_id, year, month, HUB_STIPEND, awardedAt);
            queries.hubs.updateHubMemberStipend(hub.id, member.user_id, HUB_STIPEND);
            queries.merit.insertEvent({
              user_id: member.user_id, event_type: 'hub_stipend', points: HUB_STIPEND,
              reference_id: hub.id, reference_type: 'hub',
              description: `Policy Hub stipend: ${hub.name}`, created_at: awardedAt
            });
          }
        });
      });
      console.log(`Hub stipend processing complete for ${year}-${month}`);
    } catch (e) { console.error('Hub stipend error:', e); }
  };
};
