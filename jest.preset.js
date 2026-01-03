const nxPreset = require('@nx/jest/preset');
const path = require('path');

module.exports = {
  ...nxPreset,
  testEnvironment: 'jsdom',
  maxWorkers: '50%',
  cacheDirectory: path.join(__dirname, '.jest/cache'),
};
