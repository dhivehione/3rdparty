module.exports = function({ merit }) {
  return function processStipends() {
    if (merit && typeof merit.processMonthlyStipends === 'function') {
      merit.processMonthlyStipends();
    }
  };
};
