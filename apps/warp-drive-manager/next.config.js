const withNx = require('@nx/next/plugins/with-nx');

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  nx: {},
  distDir: '../../.next/warp-drive-manager',
  generateBuildId: async () => 'stable-build-id',
  typescript: { ignoreBuildErrors: true },
};

module.exports = withNx(nextConfig);
