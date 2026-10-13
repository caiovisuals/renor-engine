import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * A miniature of ../../../vitest.config.ts for tests/helpers/childTree.test.ts to run for real: a
 * nested vitest run it can signal, leak from and watch, without touching the run it is part of.
 * FIXTURE_GUARD=0 leaves out the run guard so the worker backstop is the only thing that can clean up.
 */
const engine = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: engine,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/fixtures/child-tree/*.fixture.ts'],
    pool: 'forks',
    setupFiles: ['tests/setup/childTreeBackstop.ts'],
    globalSetup: process.env.FIXTURE_GUARD === '0' ? [] : ['tests/setup/orphanGuard.ts'],
  },
});
