import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The suite's fictional owner: identity aliases come from RENOR_OWNER_NAMES, which is unset by default.
    env: { RENOR_OWNER_NAMES: 'Rowan,Rowan Vale,Rowan Vale Holm' },
    include: ['tests/**/*.test.ts'],
    // Every worker gets the backstop that kills process groups a suite left behind when the
    // runner is signalled (gate timeout, Ctrl-C) — the per-file afterEach cannot run in that case.
    setupFiles: ['tests/setup/childTreeBackstop.ts'],
    // Compile the tree under test first; then the run fails if any child this run started is still
    // alive once the workers have exited.
    globalSetup: ['tests/globalSetup.ts', 'tests/setup/orphanGuard.ts'],
  },
});
