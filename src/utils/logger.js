const winston = require('winston'); // we'll install it later if needed
// Simple logger for now

const logger = {
  info: (event, meta = {}) => {
    console.log(`[INFO] ${event}`, meta);
  },
  warn: (event, meta = {}) => {
    console.warn(`[WARN] ${event}`, meta);
  },
  error: (event, meta = {}) => {
    console.error(`[ERROR] ${event}`, meta);
  }
};

module.exports = logger;
