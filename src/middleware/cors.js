module.exports = function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Override any restrictive default CSP from hosting platform
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://www.google-analytics.com https://www.google.com; frame-src 'none';");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
};
