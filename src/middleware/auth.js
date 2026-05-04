if (!process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD environment variable must be set');
  process.exit(1);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminSessions = new Map();

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Nice try, insurance agent. Wrong password.' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!adminSessions.has(token)) {
    return res.status(401).json({ error: 'Nice try, insurance agent. Wrong password.' });
  }
  next();
}

function userAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required', success: false });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');

  try {
    const user = this.db.prepare('SELECT * FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token', success: false });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed', success: false });
  }
}

module.exports = function({ db }) {
  return {
    ADMIN_PASSWORD,
    adminSessions,
    adminAuth,
    userAuth: userAuth.bind({ db })
  };
};