module.exports = function({ queries, db, getSettings, merit, maybeEngageReferral, activeVisitors }) {
  const intervals = [];

  const closeExpiredProposals = require('./closeProposals')({ queries, getSettings, merit, maybeEngageReferral });
  const processHubStipends = require('./processHubStipends')({ queries });
  const processStipends = require('./processStipends')({ merit });
  const checkEmeritus = require('./checkEmeritus')({ db });
  const cleanupExpiredVisitors = require('./cleanupVisitors')({ activeVisitors, getSettings });

  function start() {
    intervals.push(setInterval(cleanupExpiredVisitors, 60000));
    intervals.push(setInterval(closeExpiredProposals, 60000));
    intervals.push(setInterval(processStipends, 60 * 60 * 1000));
    intervals.push(setInterval(processHubStipends, 60 * 60 * 1000));
    intervals.push(setInterval(checkEmeritus, 24 * 60 * 60 * 1000));

    closeExpiredProposals();
    processStipends();
    processHubStipends();
    checkEmeritus();
  }

  function stop() {
    intervals.forEach(clearInterval);
  }

  return { start, stop };
};
