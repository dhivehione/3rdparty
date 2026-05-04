function sanitizeHTML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function generateOTP(length) {
  const len = parseInt(length) || 6;
  let otp = '';
  for (let i = 0; i < len; i++) {
    otp += Math.floor(Math.random() * 10).toString();
  }
  return otp;
}

module.exports = { sanitizeHTML, generateOTP };