const express = require('express');
const path = require('path');
const router = express.Router();

router.get('/', (req, res) => res.sendFile(path.join(__dirname, '../../index.html')));
router.get('/join', (req, res) => res.sendFile(path.join(__dirname, '../../join.html')));
router.get('/intro', (req, res) => res.sendFile(path.join(__dirname, '../../intro.html')));
router.get('/how', (req, res) => res.redirect('/how-it-works'));
router.get('/how-it-works', (req, res) => res.sendFile(path.join(__dirname, '../../how.html')));
router.get('/wall', (req, res) => res.sendFile(path.join(__dirname, '../../wall.html')));
router.get('/donate', (req, res) => res.sendFile(path.join(__dirname, '../../donate.html')));
router.get('/treasury', (req, res) => res.sendFile(path.join(__dirname, '../../treasury.html')));
router.get('/events', (req, res) => res.sendFile(path.join(__dirname, '../../events.html')));
router.get('/join-success', (req, res) => res.sendFile(path.join(__dirname, '../../join-success.html')));
router.get('/whitepaper', (req, res) => res.sendFile(path.join(__dirname, '../../whitepaper.html')));
router.get('/policies', (req, res) => res.sendFile(path.join(__dirname, '../../policies.html')));
router.get('/proposals', (req, res) => res.sendFile(path.join(__dirname, '../../proposals.html')));
router.get('/legislature', (req, res) => res.sendFile(path.join(__dirname, '../../legislature.html')));
router.get('/laws', (req, res) => res.sendFile(path.join(__dirname, '../../laws.html')));
router.get('/law-stats', (req, res) => res.sendFile(path.join(__dirname, '../../law-stats.html')));
router.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../../admin.html')));
router.get('/profile', (req, res) => res.sendFile(path.join(__dirname, '../../profile.html')));
router.get('/generate-law', (req, res) => res.sendFile(path.join(__dirname, '../../generate-law.html')));
router.get('/leadership', (req, res) => res.sendFile(path.join(__dirname, '../../leadership.html')));
router.get('/faq', (req, res) => res.sendFile(path.join(__dirname, '../../faq.html')));
router.get('/enroll', (req, res) => res.sendFile(path.join(__dirname, '../../enroll.html')));

module.exports = router;