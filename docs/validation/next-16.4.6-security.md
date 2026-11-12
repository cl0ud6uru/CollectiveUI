# Next.js 16.4.6 security patch validation

Validated on 2026-11-12 with Node.js 24.19.0 and npm 11.9.0.

## Change and evidence

- Pin `next` and `eslint-config-next` to 16.4.6 from 16.4.3. The lockfile changes only the matching Next.js package family; other dependency versions stay unchanged.
- The vendor's [GHSA-pc58-hwjq-p385 / CVE-2026-119348 advisory](https://github.com/vercel/next.js/security/advisories/GHSA-pc58-hwjq-p385) includes 16.4.3 in its affected range (`>=16.0.0, <=16.4.4`) and identifies 16.4.5 as patched. It describes cross-client response injection/disclosure when self-hosted applications forward fetched responses through a qualifying HTTP/1.1 reverse proxy. This confirms an affected dependency version; application-level exploitation was not established.
- The [16.4.5 security release](https://github.com/vercel/next.js/releases/tag/v16.4.5) also fixes cache isolation, SVG rejection, and Edge-runtime cookie-header issues. [16.4.6](https://github.com/vercel/next.js/releases/tag/v16.4.6) adds the route-handler compression follow-up and remains within the existing minor release.
- `npm audit --omit=dev --json` reported zero vulnerabilities both before and after the patch. The vendor advisory, rather than the npm audit result, establishes the need for this update.

## Validation

- `npm run typecheck`: passed, including route type generation using 16.4.6.
- `npm run lint`: passed with zero errors. Existing/unrelated working-tree warnings were reported.
- `npm ls next eslint-config-next @next/env @next/eslint-plugin-next --depth=1`: all applicable packages resolve to 16.4.6, including the `next-auth` peer.
- `git diff --check -- package.json package-lock.json`: passed.
- An isolated temporary App Router fixture was built with `next build --webpack` and served with `next start` using the worktree's 16.4.6 installation. HTTP checks passed:
  - Three gzip-compressed SSE messages arrived in separate chunks at approximately 27, 339, and 549 ms; delivery was not buffered until completion.
  - A 65,536-byte binary attachment arrived byte-for-byte intact and retained `Content-Disposition`.
  - A deliberately incorrect route response `Content-Length` was removed, confirming the patched response-framing behavior.

## Compatibility scope

This is a framework dependency update with no UI changes. Web, iOS, and macOS continue using the same API contracts. The existing workspace download and computer-frame handlers set `Content-Length`; patched Next.js may remove it on the wire. A source check found no native or web client dependency on that header and no API handler returning a precompressed body. Deployment-specific reverse-proxy behavior was not tested, and no production changes were made.
