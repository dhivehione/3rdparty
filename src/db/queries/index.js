module.exports = function({ db, lawsDb }) {
  return {
    signups: require('./signups')(db),
    proposals: require('./proposals')(db),
    wall: require('./wall')(db),
    merit: require('./merit')(db),
    referrals: require('./referrals')(db),
    treasury: require('./treasury')(db),
    endorsements: require('./endorsements')(db),
    bounties: require('./bounties')(db),
    laws: require('./laws')(lawsDb),
    leadership: require('./leadership')(db),
    hubs: require('./hubs')(db),
    events: require('./events')(db),
    donations: require('./donations')(db),
    activityLog: require('./activity-log')(db),
  };
};
