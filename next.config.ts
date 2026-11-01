import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // AuraPay is wallet-driven and request-scoped (sessions, live quotes, payment
  // state). We opt out of Cache Components / partial prefetching so that every
  // API route and page stays fully dynamic and never serves cached financial data.
  cacheComponents: false,
  poweredByHeader: false,
  // Native/WASM database drivers must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
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
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
