module.exports = function({ queries, db, getSettings, merit, maybeEngageReferral, activeVisitors, notificationQueue }) {
  const intervals = [];

  const closeExpiredProposals = require('./closeProposals')({ queries, getSettings, merit, maybeEngageReferral });
  const processHubStipends = require('./processHubStipends')({ queries, getSettings });
  const processStipends = require('./processStipends')({ merit });
  const checkEmeritus = require('./checkEmeritus')({ db });
  const cleanupExpiredVisitors = require('./cleanupVisitors')({ activeVisitors, getSettings });
  const processNotifications = require('./processNotifications')({ notificationQueue });

  function start() {
    intervals.push(setInterval(cleanupExpiredVisitors, 60000));
    intervals.push(setInterval(closeExpiredProposals, 60000));
    intervals.push(setInterval(processStipends, 60 * 60 * 1000));
    intervals.push(setInterval(processHubStipends, 60 * 60 * 1000));
    intervals.push(setInterval(checkEmeritus, 24 * 60 * 60 * 1000));

    const settings = getSettings();
    const notificationInterval = settings.notification_batch_interval_ms || 5 * 60 * 1000;
    intervals.push(setInterval(processNotifications, Math.max(30000, notificationInterval)));

    closeExpiredProposals();
    processStipends();
    processHubStipends();
    checkEmeritus();
    processNotifications();
  }

  function stop() {
    intervals.forEach(clearInterval);
  }

  return { start, stop };
};
