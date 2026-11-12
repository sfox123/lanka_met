/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // NEXT_DIST_DIR lets a second server or a build run beside `npm run dev` without the two
  // overwriting each other's files in .next
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: false,
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
