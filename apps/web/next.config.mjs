/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them itself.
  transpilePackages: ["@rostr/core", "@rostr/db", "@rostr/pinning"],
  serverExternalPackages: ["pg"],
};

export default nextConfig;
