/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,          // the 3D scene + WebSocket manage their own lifecycles
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  webpack: (config) => {
    config.module.rules.push({ test: /\.(glb|gltf)$/, type: 'asset/resource' });
    return config;
  },
  experimental: { largePageDataBytes: 8 * 1024 * 1024 },
};
export default nextConfig;
