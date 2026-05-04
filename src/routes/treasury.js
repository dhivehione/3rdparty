const express = require('express');
const router = express.Router();

module.exports = function({ queries, adminAuth, logActivity, addTreasuryEntry, getTreasuryBalance, getSettings }) {
  router.get('/api/treasury/summary', (req, res) => {
    try {
      const income = queries.treasury.getIncomeTotal();
      const expenses = queries.treasury.getExpensesTotal();
      const txCount = queries.treasury.getTransactionCount();
      const donationCount = queries.treasury.getDonationCount();
      const settings = getSettings();

      res.json({
        success: true,
        balance: Math.round((income - expenses) * 100) / 100,
        total_income: Math.round(income * 100) / 100,
        total_expenses: Math.round(expenses * 100) / 100,
        transaction_count: txCount,
        donation_count: donationCount,
        target_treasury: settings.target_treasury
      });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch treasury summary', success: false });
    }
  });

  router.get('/api/treasury/ledger', (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 25));
      const offset = (page - 1) * limit;
      const filterType = req.query.type || null;
      const filterCategory = req.query.category || null;

      let whereClause = "WHERE status = 'verified'";
      const params = [];

      if (filterType && ['donation', 'expenditure'].includes(filterType)) {
        whereClause += ' AND type = ?';
        params.push(filterType);
      }
      if (filterCategory) {
        whereClause += ' AND category = ?';
        params.push(filterCategory);
      }

      const { count, rows } = queries.treasury.getLedgerFiltered(whereClause, params, limit, offset);
      const balance = getTreasuryBalance();

      res.json({
        success: true,
        balance,
        transactions: rows,
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit)
      });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch treasury ledger', success: false });
    }
  });

  router.get('/api/admin/treasury/expenditures', adminAuth, (req, res) => {
    try {
      const expenditures = queries.treasury.getExpenditures();
      const balance = getTreasuryBalance();
      res.json({ success: true, expenditures, balance });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch expenditures', success: false });
    }
  });

  router.post('/api/admin/treasury/expenditure', adminAuth, (req, res) => {
    const { amount, description, category } = req.body;

    if (!amount || !description) {
      return res.status(400).json({ error: 'Amount and description are required', success: false });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount', success: false });
    }

    try {
      const result = addTreasuryEntry({
        type: 'expenditure',
        amount: parsedAmount,
        description: description.trim(),
        category: category || 'operational',
        sourceRefType: 'manual',
        verifiedBy: 'admin',
        status: 'verified'
      });

      logActivity('treasury_expenditure', null, result.lastInsertRowid, {
        amount: parsedAmount,
        description: description.trim(),
        category: category || 'operational'
      }, req);

      res.status(201).json({
        success: true,
        message: 'Expenditure recorded in Live Treasury',
        id: result.lastInsertRowid,
        balance: getTreasuryBalance()
      });
    } catch (error) {
      console.error('Expenditure creation error:', error);
      res.status(500).json({ error: 'Could not create expenditure', success: false });
    }
  });

  router.get('/api/admin/treasury/ledger', adminAuth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const { count, rows } = queries.treasury.getLedgerAdmin(limit, offset);

      res.json({
        success: true,
        transactions: rows,
        balance: getTreasuryBalance(),
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit)
      });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch treasury ledger', success: false });
    }
  });

  return router;
};
