const nxPreset = require('@nx/jest/preset');
const path = require('path');

const isCI = !!process.env.CI;

module.exports = {
  ...nxPreset,
  testEnvironment: 'jsdom',
  maxWorkers: isCI ? '100%': '50%',
  cacheDirectory: path.join(__dirname, '.jest/cache'),
};
