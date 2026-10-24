import { defineConfig } from 'vitest/config';
import DurationSequencer from './tests/setup/durationSequencer.mjs';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The suite's fictional owner: identity aliases come from RENOR_OWNER_NAMES, which is unset by default.
    env: { RENOR_OWNER_NAMES: 'Rowan,Rowan Vale,Rowan Vale Holm' },
    // Start the slowest files first (vitest's own cache, else the seconds recorded in tests/setup/test-durations.json), so no worker is
    // left holding the longest file after the others are done. It only orders; it selects and skips nothing.
    sequence: { sequencer: DurationSequencer },
    include: ['tests/**/*.test.ts'],
    // A `.only` left in a file runs that test and silently skips the rest of the file. vitest refuses it only when CI is set,
    // and a gate slot does not set it, so refuse it here: a run with a `.only` fails. (`npx vitest --allowOnly` to iterate.)
    allowOnly: false,
    // Every worker gets the backstop that kills process groups a suite left behind when the
    // runner is signalled (gate timeout, Ctrl-C) — the per-file afterEach cannot run in that case.
    setupFiles: ['tests/setup/childTreeBackstop.ts'],
    // Scratch first: a temp directory on a disk moves to RAM when RAM can spare the room, so a run
    // does not write its fixtures to the SSD (tests/setup/ramScratch.ts). Then compile the tree
    // under test; then the run fails if any child this run started is still alive once the
    // workers have exited.
    globalSetup: ['tests/setup/ramScratch.ts', 'tests/globalSetup.ts', 'tests/setup/orphanGuard.ts'],
  },
});
