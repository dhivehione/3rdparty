const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

module.exports = function({ db, dataDir, getSettings, logActivity }) {

  // GET /api/donation-info - Get bank details (public)
  router.get('/api/donation-info', (req, res) => {
    try {
      res.json({
        success: true,
        bank_name: process.env.DONATION_BANK_NAME || 'Bank of Maldives',
        account_name: process.env.DONATION_ACCOUNT_NAME || '3d Party',
        account_number: process.env.DONATION_ACCOUNT_NUMBER || '—'
      });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch donation info', success: false });
    }
  });

  // POST /api/donate - Submit donation with slip
  const upload = multer({
    dest: path.join(dataDir, 'uploads'),
    limits: { fileSize: getSettings().max_upload_bytes },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only images allowed'));
      }
      cb(null, true);
    }
  });

  const uploadDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  router.post('/api/donate', upload.single('slip'), (req, res) => {
    const phone = req.body.phone || null;
    const nid = req.body.nid || null;
    const amount = req.body.amount;
    const remarks = req.body.remarks || null;

    if (!amount) {
      return res.status(400).json({ error: 'Donation amount is required', success: false });
    }

    const donationAmount = parseFloat(amount);
    if (isNaN(donationAmount) || donationAmount <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount', success: false });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Deposit slip is required', success: false });
    }

    // Detect logged-in user so merit can be awarded on verification
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) userId = user.id;
      } catch (e) {}
    }

    try {
      const createdAt = new Date().toISOString();

      const donationCols = db.prepare(`PRAGMA table_info(donations)`).all();
      const colNames = donationCols.map(c => c.name);
      
      let insertCols = ['amount', 'slip_filename', 'status', 'created_at'];
      let insertVals = [donationAmount, req.file.filename, 'pending', createdAt];
      
      if (colNames.includes('phone')) { insertCols.push('phone'); insertVals.push(phone); }
      if (colNames.includes('nid')) { insertCols.push('nid'); insertVals.push(nid); }
      if (colNames.includes('remarks')) { insertCols.push('remarks'); insertVals.push(remarks); }
      if (colNames.includes('user_id')) { insertCols.push('user_id'); insertVals.push(userId); }

      const placeholders = insertVals.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO donations (${insertCols.join(', ')}) VALUES (${placeholders})`);
      const result = stmt.run(...insertVals);
      
      logActivity('donation_pending', userId, null, {
        phone: phone ? phone.substring(0, 3) + 'xxxx' : null,
        nid: nid ? nid.substring(0, 2) + 'xxxxx' : null,
        amount: donationAmount,
        slip: req.file.filename
      }, req);
      
      res.json({ success: true, message: 'Donation submitted for verification' });
    } catch (error) {
      console.error('Donation error:', error);
      res.status(500).json({ error: 'Could not process donation', success: false });
    }
  });

  return router;
};
