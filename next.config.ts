// SPDX-License-Identifier: AGPL-3.0-only
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Studio reads a local SQLite database on every request: plain dynamic rendering,
  // no Cache Components.
  serverExternalPackages: [],
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
