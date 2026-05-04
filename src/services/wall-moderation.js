function moderateWallContent(text) {
  const lower = text.toLowerCase().trim();
  let score = 0;
  let reasons = [];

  const blacklist = [
    'fuck', 'shit', 'asshole', 'bastard', 'bitch', 'cunt', 'dick', 'piss', 'douche',
    'motherfucker', 'motherfucking',
    'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'chink', 'kike', 'spic',
    'wetback', 'tranny', 'fag', 'dyke', 'paki',
    'huththu', 'kaley', 'manyaa', 'handi', 'meyraa', 'thaakathu',
    'kill yourself', 'kys', 'go die', 'suicide', 'hang yourself', 'shoot yourself',
    'you are worthless', 'nobody cares', 'just shut up', 'you are stupid'
  ];

  for (const word of blacklist) {
    const regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    const matches = lower.match(regex);
    if (matches) {
      score += matches.length * 25;
      reasons.push('profanity/hate-speech');
      break;
    }
  }

  if (text.length > 20) {
    const upperCount = (text.match(/[A-Z]/g) || []).length;
    const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && (upperCount / letterCount) > 0.7) {
      score += 30;
      reasons.push('excessive-caps');
    }
  }

  const repeatedChars = (text.match(/(.)\1{4,}/g) || []);
  if (repeatedChars.length > 0) {
    score += repeatedChars.length * 5;
    reasons.push('char-spam');
  }

  const exclamationCount = (text.match(/!/g) || []).length;
  const questionCount = (text.match(/\?/g) || []).length;
  if (exclamationCount > 5 || questionCount > 5) {
    score += 10;
    reasons.push('excessive-punctuation');
  }

  if (text.length < 5 && text === text.toUpperCase() && text.match(/[A-Z]{2,}/)) {
    score += 15;
    reasons.push('shout-post');
  }

  return {
    passed: score < 20,
    score,
    reason: reasons.length > 0 ? reasons.join(', ') : null
  };
}

module.exports = { moderateWallContent };