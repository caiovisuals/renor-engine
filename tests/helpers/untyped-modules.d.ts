// The gate's own scripts are plain ESM JavaScript (.mjs) with no declaration file, so a test that
// imports them gets an implicit `any` (TS7016). Declaring exactly these two modules keeps that
// explicit and narrow: a NEW untyped import still fails the typecheck instead of slipping through.
declare module '*/scripts/gate/agent-gate.mjs';
declare module '*/scripts/ci/check-gateway-deps.mjs';
