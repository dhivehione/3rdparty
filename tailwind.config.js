module.exports = {
  content: [
    "./*.html",
    "./*.js",
    "./js/**/*.js",
    "./src/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        party: {
          dark: '#0f0f1a',
          card: '#1a1a2e',
          accent: '#FFD700',
          secondary: '#4A90E2',
          muted: '#6B7280'
        }
      }
    }
  }
};
