import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * Attachment extraction loads these packages by name in a child process (src/lib/files/extract.ts), so nothing in
 * the server bundle imports them and standalone tracing would drop them. Include each with its dependencies.
 */
function packageClosure(names: string[]) {
  const root = process.cwd(), dirs = new Set<string>();
  const visit = (name: string, from: string) => {
    for (let at = from; ; at = path.dirname(at)) {
      const dir = path.join(at, "node_modules", name);
      if (existsSync(path.join(dir, "package.json"))) {
        if (dirs.has(dir)) return;
        dirs.add(dir);
        const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
        for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
        return;
      }
      if (at === path.dirname(at)) throw new Error(`Cannot find ${name} for output tracing`);
    }
  };
  for (const name of names) visit(name, root);
  return [...dirs].map((dir) => `./${path.relative(root, dir).split(path.sep).join("/")}/**/*`);
}

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "ldapts", "pg-boss", "unpdf", "mammoth", "google-auth-library", "gaxios"],
  experimental: {
    serverActions: { bodySizeLimit: "30mb" },
    // proxy.ts buffers request bodies and silently truncates past this (default 10 MB), which broke uploads between
    // 10 MB and the 20 MB default upload limit (Hermes accepts 25 MB). Keep in step with the largest upload route.
    proxyClientMaxBodySize: "30mb",
  },
  outputFileTracingIncludes: { "/api/files": packageClosure(["mammoth", "unpdf"]) },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
