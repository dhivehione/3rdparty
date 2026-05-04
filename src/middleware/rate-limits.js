module.exports = function({ getSettings }) {
  const enrollRateLimits = new Map();

  function checkEnrollRateLimit(ip) {
    const settings = getSettings();
    const ENROLL_RATE_LIMIT_MS = settings.enroll_rate_limit_ms;
    const ENROLL_MAX_PER_DAY = settings.enroll_max_per_day;
    const now = Date.now();
    const record = enrollRateLimits.get(ip);

    if (!record) {
      enrollRateLimits.set(ip, { lastRequest: now, dailyCount: 1, dailyReset: new Date(now + 24 * 60 * 60 * 1000) });
      return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
    }

    if (now > record.dailyReset.getTime()) {
      record.dailyCount = 1;
      record.dailyReset = new Date(now + 24 * 60 * 60 * 1000);
      enrollRateLimits.set(ip, record);
      return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
    }

    if (record.dailyCount >= ENROLL_MAX_PER_DAY) {
      return { allowed: false, remaining: 0, resetIn: record.dailyReset.getTime() - now };
    }

    if (now - record.lastRequest < ENROLL_RATE_LIMIT_MS) {
      return { allowed: false, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: ENROLL_RATE_LIMIT_MS - (now - record.lastRequest) };
    }

    record.lastRequest = now;
    record.dailyCount++;
    enrollRateLimits.set(ip, record);

    return { allowed: true, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: 0 };
  }

  return { enrollRateLimits, checkEnrollRateLimit };
};
