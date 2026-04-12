const nxPreset = require('@nx/jest/preset');
const path = require('path');

module.exports = {
  ...nxPreset,
  testEnvironment: 'jsdom',
  cacheDirectory: path.join(__dirname, '.jest/cache'),
};
