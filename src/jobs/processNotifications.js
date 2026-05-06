module.exports = function({ notificationQueue }) {
  return function processNotifications() {
    notificationQueue.processQueue();
  };
};
