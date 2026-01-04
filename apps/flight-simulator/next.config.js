const withNx = require('@nx/next/plugins/with-nx');

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  nx: {},
  distDir: '../../.next/flight-simulator',
};

module.exports = withNx(nextConfig);
