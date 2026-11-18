import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pakiety z monorepo są publikowane jako źródła TypeScript — Next musi je skompilować sam.
  transpilePackages: ["@taskplanner/core", "@taskplanner/sync", "@taskplanner/db"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
