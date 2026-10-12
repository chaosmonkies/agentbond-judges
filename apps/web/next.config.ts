import type { NextConfig } from 'next';
const config: NextConfig = {transpilePackages:['@agentbond/sdk'], devIndicators: false,distDir:process.env.AGENTBOND_WEB_BUILD_DIR??'.next'};
export default config;
