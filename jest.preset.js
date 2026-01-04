const nxPreset = require('@nx/jest/preset');

module.exports = {
  ...nxPreset,
  testEnvironment: 'jsdom',
};
