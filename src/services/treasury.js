module.exports = function({ db }) {
  function addTreasuryEntry(data) {
    const { type, amount, description, category, sourceRefType, sourceRefId, donorNickname, verifiedBy, status } = data;
    const now = new Date().toISOString();
    const entryStatus = status || 'verified';
    const verifiedAt = entryStatus === 'verified' ? now : null;
    return db.prepare(`
      INSERT INTO treasury_ledger (type, amount, description, category, source_ref_type, source_ref_id, donor_nickname, verified_by, status, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(type, amount, description, category || null, sourceRefType || null, sourceRefId || null, donorNickname || null, verifiedBy || null, entryStatus, now, verifiedAt);
  }

  function getTreasuryBalance() {
    const income = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM treasury_ledger WHERE type = 'donation' AND status = 'verified'`).get();
    const expenses = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM treasury_ledger WHERE type = 'expenditure' AND status = 'verified'`).get();
    return income.total - expenses.total;
  }

  return { addTreasuryEntry, getTreasuryBalance };
};