import { defineConfig } from "vitest/config";

// Live tests hit real external services (NWC test-wallet faucet, VTpass sandbox).
// Run with: npm run test:live -w server
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
