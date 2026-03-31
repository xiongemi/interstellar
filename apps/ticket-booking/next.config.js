const withNx = require('@nx/next/plugins/with-nx');

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  nx: {},
  distDir: '../../.next/ticket-booking',
  generateBuildId: async () => 'stable-build-id',
  typescript: { ignoreBuildErrors: true },
};

module.exports = withNx(nextConfig);
