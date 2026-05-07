module.exports = function({ queries, getSettings, merit }) {
  return function processHubStipends() {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const HUB_STIPEND = getSettings().hub_stipend;
      const activeHubs = queries.hubs.getActiveHubsForStipends();
      activeHubs.forEach(hub => {
        const members = queries.hubs.getHubMembersForStipends(hub.id);
        members.forEach(member => {
          const existing = queries.hubs.getExistingHubStipend(hub.id, member.user_id, year, month);
          if (!existing) {
            const awardedAt = now.toISOString();
            queries.hubs.insertHubStipend(hub.id, member.user_id, year, month, HUB_STIPEND, awardedAt);
            queries.hubs.updateHubMemberStipend(hub.id, member.user_id, HUB_STIPEND);
            merit.awardMerit(member.user_id, 'hub_stipend', HUB_STIPEND, hub.id, 'hub', `Policy Hub stipend: ${hub.name}`);
          }
        });
      });
      console.log(`Hub stipend processing complete for ${year}-${month}`);
    } catch (e) { console.error('Hub stipend error:', e); }
  };
};
