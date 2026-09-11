import { defineConfig } from 'vitest/config';

// Integration tests require a real NebulaGraph 5.3 instance.
// Configure via env vars: NEBULA_HOST, NEBULA_PORT, NEBULA_USER, NEBULA_PASSWORD
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
