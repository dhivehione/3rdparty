async function sendSMS(phone, message, settings) {
  const provider = (settings.sms_provider || '').toLowerCase();

  if (!provider) {
    console.log(`[SMS] No provider configured. OTP for ${phone}: ${message}`);
    return { sent: false, error: 'No SMS provider configured', dev_message: message };
  }

  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.startsWith('960') && cleaned.length === 10) {
      cleaned = '+' + cleaned;
    } else if (cleaned.length === 7) {
      cleaned = '+960' + cleaned;
    } else if (cleaned.length === 10 && cleaned.startsWith('0')) {
      cleaned = '+960' + cleaned.substring(1);
    }
  }

  if (provider === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID || settings.sms_twilio_account_sid;
    const authToken = process.env.TWILIO_AUTH_TOKEN || settings.sms_twilio_auth_token;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || settings.sms_twilio_phone_number;

    if (!accountSid || !authToken || !fromNumber) {
      console.log(`[SMS] Twilio not configured. OTP for ${phone}: ${message}`);
      return { sent: false, error: 'Twilio credentials missing', dev_message: message };
    }

    try {
      const https = await import('https');
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const body = new URLSearchParams({
        To: cleaned,
        From: fromNumber,
        Body: message
      }).toString();

      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.twilio.com',
          path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error_code) {
                console.error('[SMS] Twilio error:', parsed.message);
                resolve({ sent: false, error: parsed.message });
              } else {
                console.log(`[SMS] Sent to ${phone}: ${parsed.sid}`);
                resolve({ sent: true, sid: parsed.sid });
              }
            } catch (e) {
              resolve({ sent: false, error: 'Twilio parse error' });
            }
          });
        });
        req.on('error', (e) => {
          console.error('[SMS] Request error:', e.message);
          resolve({ sent: false, error: e.message });
        });
        req.write(body);
        req.end();
      });
    } catch (e) {
      console.error('[SMS] Twilio setup error:', e.message);
      return { sent: false, error: e.message };
    }
  }

  if (provider === 'webhook') {
    const webhookUrl = settings.sms_webhook_url;
    if (!webhookUrl) {
      return { sent: false, error: 'Webhook URL not configured' };
    }
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleaned, message })
      });
      if (response.ok) {
        console.log(`[SMS] Webhook sent to ${phone}`);
        return { sent: true };
      }
      return { sent: false, error: `Webhook returned ${response.status}` };
    } catch (e) {
      console.error('[SMS] Webhook error:', e.message);
      return { sent: false, error: e.message };
    }
  }

  console.log(`[SMS] Unknown provider '${provider}'. OTP for ${phone}: ${message}`);
  return { sent: false, error: `Unknown provider: ${provider}`, dev_message: message };
}

module.exports = { sendSMS };
