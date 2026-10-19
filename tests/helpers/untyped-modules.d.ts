// The gate's own scripts are plain ESM JavaScript (.mjs) with no declaration file, so a test that
// imports them gets an implicit `any` (TS7016). Declaring exactly these two modules keeps that
// explicit and narrow: a NEW untyped import still fails the typecheck instead of slipping through.
declare module '*/scripts/gate/agent-gate.mjs';
declare module '*/scripts/gate/test-inventory.mjs';
declare module '*/scripts/ci/check-gateway-deps.mjs';
// The release script (scripts/release) is the same kind of module: plain ESM JavaScript, imported by its own tests.
declare module '*/scripts/release/run-release.mjs';
declare module '*/scripts/release/lib/sql-scan.mjs';
declare module '*/scripts/release/lib/evidence.mjs';
declare module '*/scripts/release/lib/exec.mjs';
declare module '*/scripts/release/lib/remote.mjs';
declare module '*/scripts/release/lib/supabase.mjs';
declare module '*/scripts/release/lib/parity.mjs';
declare module '*/scripts/release/lib/report.mjs';
declare module '*/scripts/release/lib/runtime.mjs';
declare module '*/scripts/release/lib/state.mjs';
declare module '*/scripts/release/lib/steps-post.mjs';
