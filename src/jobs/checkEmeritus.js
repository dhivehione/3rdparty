module.exports = function({ db }) {
  return function checkEmeritusEligibility() {
    try {
      const threeYearsAgo = new Date();
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
      const threeYearsAgoStr = threeYearsAgo.toISOString();

      // Get all verified members with 3+ years tenure and their total merit
      const members = db.prepare(`
        SELECT s.id, s.timestamp,
          COALESCE((SELECT SUM(me.points) FROM merit_events me WHERE me.user_id = s.id), 0) as total_merit
        FROM signups s
        WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
        AND s.timestamp <= ?
      `).all(threeYearsAgoStr);

      // Calculate 99th percentile merit threshold
      let threshold = 0;
      if (members.length > 0) {
        const merits = members.map(m => m.total_merit).sort((a, b) => a - b);
        const idx = Math.ceil(merits.length * 0.99) - 1;
        threshold = merits[Math.max(0, idx)];
      }

      const eligibleByTime = members.filter(m => m.total_merit >= threshold);

      const eligibleByCouncil = db.prepare(`
        SELECT DISTINCT lt.user_id FROM leadership_terms lt
        JOIN leadership_positions lp ON lt.position_id = lp.id
        WHERE lp.position_type = 'council' AND lp.is_active = 1
      `).all();

      const existingEmeritus = db.prepare('SELECT user_id FROM emiritus_council WHERE is_active = 1').all();
      const existingIds = new Set(existingEmeritus.map(e => e.user_id));

      const allEligible = new Set([
        ...eligibleByTime.map(e => e.id),
        ...eligibleByCouncil.map(e => e.user_id)
      ]);

      allEligible.forEach(userId => {
        if (!existingIds.has(userId)) {
          db.prepare('INSERT INTO emiritus_council (user_id, invited_at, reason) VALUES (?, ?, ?)')
            .run(userId, new Date().toISOString(), 'Met eligibility criteria for Emeritus Council');

          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_type, description, created_at)
            VALUES (?, 'emeritus_invite', 0, 'emeritus', 'Invited to Emeritus Council', ?)
          `).run(userId, new Date().toISOString());
        }
      });

      console.log(`Emeritus Council check complete: ${allEligible.size} members eligible`);
    } catch (e) {
      console.error('Emeritus check error:', e);
    }
  };
};
