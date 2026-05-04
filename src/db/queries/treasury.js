module.exports = function(db) {
  return {
    getIncomeTotal() {
      const result = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM treasury_ledger WHERE type = 'donation' AND status = 'verified'").get();
      return result?.total || 0;
    },
    getExpensesTotal() {
      const result = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM treasury_ledger WHERE type = 'expenditure' AND status = 'verified'").get();
      return result?.total || 0;
    },
    getTransactionCount() {
      return db.prepare("SELECT COUNT(*) as total FROM treasury_ledger WHERE status = 'verified'").get().total;
    },
    getDonationCount() {
      return db.prepare("SELECT COUNT(*) as total FROM treasury_ledger WHERE type = 'donation' AND status = 'verified'").get().total;
    },
    getLedgerFiltered(whereClause, params, limit, offset) {
      const count = db.prepare(`SELECT COUNT(*) as total FROM treasury_ledger ${whereClause}`).get(...params).total;
      const rows = db.prepare(`SELECT * FROM treasury_ledger ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { count, rows };
    },
    getExpenditures() {
      return db.prepare("SELECT * FROM treasury_ledger WHERE type = 'expenditure' ORDER BY created_at DESC").all();
    },
    getLedgerAdmin(limit, offset) {
      const count = db.prepare('SELECT COUNT(*) as total FROM treasury_ledger').get().total;
      const rows = db.prepare('SELECT * FROM treasury_ledger ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      return { count, rows };
    },
    insert(entry) {
      return db.prepare(
        'INSERT INTO treasury_ledger (type, amount, description, category, source_ref_type, source_ref_id, donor_nickname, verified_by, status, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(entry.type, entry.amount, entry.description, entry.category, entry.source_ref_type, entry.source_ref_id, entry.donor_nickname, entry.verified_by, entry.status, entry.created_at, entry.verified_at);
    },
    getBalance() {
      const income = this.getIncomeTotal();
      const expenses = this.getExpensesTotal();
      return { income, expenses, balance: income - expenses };
    },
  };
};
