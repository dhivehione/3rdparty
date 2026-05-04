module.exports = function(db) {
  return {
    getById(id) {
      return db.prepare('SELECT * FROM signups WHERE id = ?').get(id);
    },
    getByNameOrUsername(name) {
      return db.prepare('SELECT name, username FROM signups WHERE id = ?').get(name);
    },
    getByPhone(phone) {
      return db.prepare('SELECT id, phone, name, username, is_verified FROM signups WHERE phone = ?').get(phone);
    },
    getByPhoneUnverified(phone) {
      return db.prepare('SELECT id, otp_code, otp_expires_at, otp_verified FROM signups WHERE phone = ? AND is_verified = 0').get(phone);
    },
    getByNid(nid) {
      return db.prepare('SELECT id, phone, name, username, is_verified FROM signups WHERE nid = ?').get(nid);
    },
    getByPhoneOrNid(phone, nid) {
      return db.prepare('SELECT id, is_verified FROM signups WHERE phone = ? OR nid = ?').get(phone, nid);
    },
    getByPhoneOrNidDup(phone, nid) {
      return db.prepare('SELECT id FROM signups WHERE phone = ? OR nid = ?').get(phone, nid);
    },
    getByUsername(username) {
      return db.prepare('SELECT id FROM signups WHERE username = ?').get(username);
    },
    getByUsernameExcept(username, excludeId) {
      return db.prepare('SELECT id FROM signups WHERE username = ? AND id != ?').get(username, excludeId);
    },
    getByAuthToken(token) {
      return db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
    },
    getAuthToken(id) {
      return db.prepare('SELECT auth_token FROM signups WHERE id = ?').get(id);
    },
    loginByPassword(usernameOrNid, passwordHash) {
      return db.prepare('SELECT * FROM signups WHERE (username = ? OR nid = ?) AND password_hash = ? AND is_verified = 1').get(usernameOrNid, usernameOrNid, passwordHash);
    },
    loginByLegacy(usernameOrNid, phone) {
      return db.prepare('SELECT * FROM signups WHERE (username = ? OR nid = ?) AND phone = ? AND is_verified = 1').get(usernameOrNid, usernameOrNid, phone);
    },
    loginByPhoneNid(phone, nid) {
      return db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(phone, nid);
    },
    count() {
      return db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
    },
    countVerified() {
      return db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get().total;
    },
    countDonors() {
      return db.prepare('SELECT COUNT(*) as total FROM signups WHERE donation_amount > 0').get().total;
    },
    countToday(today) {
      return db.prepare('SELECT COUNT(*) as total FROM signups WHERE timestamp >= ?').get(today).total;
    },
    countNewJoinsSince(date) {
      return db.prepare('SELECT COUNT(*) as total FROM signups WHERE timestamp > ?').get(date).total;
    },
    getAllPaginated(limit, offset) {
      return db.prepare('SELECT * FROM signups ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
    },
    getTimestamp(id) {
      return db.prepare('SELECT timestamp FROM signups WHERE id = ?').get(id);
    },
    getDonors() {
      return db.prepare('SELECT id, name, username, donation_amount, timestamp FROM signups WHERE donation_amount > 0').all();
    },
    create(data) {
      return db.prepare(
        'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, otp_code, otp_expires_at, otp_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(data.phone, data.nid, data.name, data.username, data.email, data.island, data.contribution_type, data.donation_amount, data.initial_merit_estimate, data.is_verified, data.otp_code, data.otp_expires_at, data.otp_verified, data.auth_token, data.timestamp);
    },
    updateOTP(id, otpCode, otpExpiresAt) {
      return db.prepare('UPDATE signups SET otp_code = ?, otp_expires_at = ? WHERE id = ?').run(otpCode, otpExpiresAt, id);
    },
    verify(id, authToken, lastLogin) {
      return db.prepare('UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ?, otp_code = NULL, otp_expires_at = NULL, last_login = ? WHERE id = ?').run(authToken, lastLogin, id);
    },
    autoVerify(id, authToken) {
      return db.prepare('UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ? WHERE id = ?').run(authToken, id);
    },
    updateLoginToken(id, authToken, lastLogin) {
      return db.prepare('UPDATE signups SET auth_token = ?, last_login = ? WHERE id = ?').run(authToken, lastLogin, id);
    },
    logout(phone) {
      db.prepare('UPDATE signups SET auth_token = NULL WHERE phone = ?').run(phone);
    },
    updateUsername(id, username) {
      return db.prepare('UPDATE signups SET username = ? WHERE id = ?').run(username, id);
    },
    updateName(id, name) {
      return db.prepare('UPDATE signups SET name = ? WHERE id = ?').run(name, id);
    },
    updateEmail(id, email) {
      return db.prepare('UPDATE signups SET email = ? WHERE id = ?').run(email, id);
    },
    updateIsland(id, island) {
      return db.prepare('UPDATE signups SET island = ? WHERE id = ?').run(island, id);
    },
    updatePassword(id, hash) {
      return db.prepare('UPDATE signups SET password_hash = ? WHERE id = ?').run(hash, id);
    },
    updateMerit(id, points) {
      return db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?').run(points, id);
    },
    updateDonation(id, amount) {
      return db.prepare('UPDATE signups SET donation_amount = donation_amount + ? WHERE id = ?').run(amount, id);
    },
    unregister(id, unregisteredAt, justification) {
      return db.prepare('UPDATE signups SET is_verified = 0, unregistered_at = ?, unregistered_by = \'admin\', unregister_justification = ? WHERE id = ?').run(unregisteredAt, justification, id);
    },
    reregister(id) {
      return db.prepare('UPDATE signups SET is_verified = 1, unregistered_at = NULL, unregistered_by = NULL, unregister_justification = NULL WHERE id = ?').run(id);
    },
    deleteAll() {
      return db.prepare('DELETE FROM signups').run();
    },
  };
};
