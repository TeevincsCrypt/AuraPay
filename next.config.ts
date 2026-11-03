import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // AuraPay is wallet-driven and request-scoped (sessions, live quotes, payment
  // state). We opt out of Cache Components / partial prefetching so that every
  // API route and page stays fully dynamic and never serves cached financial data.
  cacheComponents: false,
  poweredByHeader: false,
  // Native/WASM database drivers must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "undici"],
  // SQL migrations are read at runtime (PGlite / DB_AUTO_MIGRATE); ship them with every function.
  outputFileTracingIncludes: {
    "/**": ["./supabase/migrations/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Profile pictures are immutable per ?v= URL and set their own caching.
        source: "/api/:path((?!avatars/).*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
  // Savings circles became Thrift (/thrift); /savings is now time-locked savings.
  async redirects() {
    return [
      { source: "/savings/new", destination: "/thrift/new", permanent: false },
      { source: "/savings/:id([0-9a-fA-F-]{36})", destination: "/thrift/:id", permanent: false },
    ];
  },
};

export default nextConfig;
