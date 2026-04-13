const withNx = require('@nx/next/plugins/with-nx');

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  nx: {},
  distDir: '../../.next/crew',
  generateBuildId: async () => 'stable-build-id',
};

module.exports = withNx(nextConfig);
