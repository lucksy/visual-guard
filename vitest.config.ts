import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Coverage gates the pure logic in lib/ (SPEC Testing Strategy: >= 80%) AND the web-app I/O shell
      // (scripts/studio/**) so the security-critical request handling is measured, not just lib/. The
      // SPA's pure view-model is a browser-loadable .js (zero-build) but is unit-tested and gated too.
      include: [
        "scripts/lib/**/*.ts",
        "scripts/studio/public/view-model.js",
        "scripts/studio/**/*.ts",
        "scripts/studio.ts",
      ],
      reporter: ["text", "text-summary"],
      thresholds: {
        // Aggregate bar across lib/** + view-model + the studio shell (serve/sync/record-figma/studio.ts
        // are integration-tested via the e2e + subprocess suites, not unit-covered to 80%, but the pure
        // logic keeps the aggregate well above this).
        lines: 80,
        functions: 80,
        statements: 80,
        // server.ts WIRES the Host / CSRF / path-traversal guards into the request handler — hold it to a
        // tight, file-specific floor so that security shell can never silently regress below it.
        "scripts/studio/server.ts": { lines: 85, statements: 85, functions: 90, branches: 70 },
      },
    },
  },
});
