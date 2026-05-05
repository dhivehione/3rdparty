const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, logActivity, getSettings, maybeEngageReferral, addTreasuryEntry, merit }) {
  router.post('/api/admin/proposals/:id/status', adminAuth, (req, res) => {
    const { status, feedback } = req.body;
    const proposalId = parseInt(req.params.id);

    if (!['approved', 'rejected', 'postponed', 'active'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status', success: false });
    }

    try {
      const stmt = db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?');
      stmt.run(status, new Date().toISOString(), proposalId);

      logActivity('proposal_status_change', null, proposalId, { status, feedback }, req);

      res.json({ success: true, message: `Proposal ${status}` });
    } catch (error) {
      console.error('Proposal status update error:', error);
      res.status(500).json({ error: 'Could not update proposal', success: false });
    }
  });

  router.get('/api/admin/proposals', adminAuth, (req, res) => {
    try {
      const proposals = db.prepare(`
        SELECT p.*,
               (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count
        FROM proposals p
        ORDER BY p.created_at DESC
      `).all();
      res.json({ proposals, success: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch proposals', success: false });
    }
  });

  router.put('/api/admin/proposals/:id', adminAuth, (req, res) => {
    const proposalId = parseInt(req.params.id);
    const { title, description, category } = req.body;

    if (!title || title.trim().length < 5) {
      return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
    }

    if (!description || description.trim().length < 20) {
      return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
    }

    try {
      const existing = db.prepare('SELECT id FROM proposals WHERE id = ?').get(proposalId);
      if (!existing) {
        return res.status(404).json({ error: 'Proposal not found', success: false });
      }

      const now = new Date().toISOString();
      const settings = getSettings();
      db.prepare(`
        UPDATE proposals
        SET title = ?, description = ?, category = ?, updated_at = ?
        WHERE id = ?
      `).run(title.trim().substring(0, settings.proposal_title_max_length), description.trim(), category || 'general', now, proposalId);

      logActivity('proposal_edited', null, proposalId, { title: title.trim() }, req);

      res.json({ success: true, message: 'Proposal updated' });
    } catch (error) {
      console.error('Proposal edit error:', error);
      res.status(500).json({ error: 'Could not update proposal', success: false });
    }
  });

  router.get('/api/admin/donations/pending', adminAuth, (req, res) => {
    try {
      const donations = db.prepare(`
        SELECT d.*, s.name, s.phone as user_phone
        FROM donations d
        LEFT JOIN signups s ON d.user_id = s.id
        WHERE d.status = 'pending'
        ORDER BY d.created_at DESC
      `).all();
      res.json({ donations, success: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch donations', success: false });
    }
  });

  router.post('/api/admin/donations/:id/verify', adminAuth, (req, res) => {
    const donationId = parseInt(req.params.id);

    try {
      const donation = db.prepare('SELECT * FROM donations WHERE id = ?').get(donationId);
      if (!donation) {
        return res.status(404).json({ error: 'Donation not found', success: false });
      }

      if (donation.status === 'verified') {
        return res.status(400).json({ error: 'Donation already verified', success: false });
      }

      db.prepare(`UPDATE donations SET status = 'verified', verified_at = ?, verified_by = ? WHERE id = ?`)
        .run(new Date().toISOString(), 'admin', donationId);

      let verifiedUserId = null;
      if (donation.user_id) {
        verifiedUserId = donation.user_id;
        db.prepare(`UPDATE signups SET donation_amount = donation_amount + ? WHERE id = ?`)
          .run(donation.amount, donation.user_id);
      } else if (donation.phone && donation.nid) {
        const user = db.prepare('SELECT id FROM signups WHERE phone = ? AND nid = ?').get(donation.phone, donation.nid);
        if (user) {
          verifiedUserId = user.id;
          db.prepare(`UPDATE signups SET donation_amount = donation_amount + ? WHERE id = ?`)
            .run(donation.amount, user.id);
        }
      }

      if (verifiedUserId) {
        const s = getSettings();
        let donationMerit;
        if (s.donation_formula === 'flat') {
          donationMerit = Math.floor(donation.amount / s.donation_divisor_mvr) * s.donation_bonus_per_100;
        } else {
          const amountUsd = donation.amount / s.donation_usd_mvr_rate;
          donationMerit = Math.round(s.donation_log_multiplier * Math.log(amountUsd + 1) / Math.log(5));
        }
        if (donationMerit > 0) {
          merit.awardMerit(verifiedUserId, 'donation_verified', donationMerit, donationId, 'donation', 'Donation verified: ' + donation.amount + ' MVR');
          maybeEngageReferral(verifiedUserId);
        }
      }

      const existingEntry = db.prepare('SELECT id FROM treasury_ledger WHERE source_ref_type = ? AND source_ref_id = ?').get('donation', donation.id);
      if (!existingEntry) {
        const donorUser = verifiedUserId ? db.prepare('SELECT name, username FROM signups WHERE id = ?').get(verifiedUserId) : null;
        const donorNick = donorUser ? (donorUser.username || donorUser.name || ('Donor #' + verifiedUserId)) : 'Anonymous';
        addTreasuryEntry({
          type: 'donation',
          amount: donation.amount,
          description: 'Verified donation' + (donation.remarks ? ': ' + donation.remarks : ''),
          category: 'donation',
          sourceRefType: 'donation',
          sourceRefId: donation.id,
          donorNickname: donorNick,
          verifiedBy: 'admin',
          status: 'verified'
        });
      }

      res.json({ success: true, message: 'Donation verified and added to treasury' });
    } catch (error) {
      console.error('Donation verify error:', error);
      res.status(500).json({ error: 'Could not verify donation', success: false });
    }
  });

  router.post('/api/admin/donations/:id/reject', adminAuth, (req, res) => {
    const donationId = parseInt(req.params.id);
    const { reason } = req.body;

    try {
      db.prepare(`UPDATE donations SET status = 'rejected', verified_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), donationId);

      res.json({ success: true, message: 'Donation rejected' });
    } catch (error) {
      res.status(500).json({ error: 'Could not reject donation', success: false });
    }
  });

  return router;
};