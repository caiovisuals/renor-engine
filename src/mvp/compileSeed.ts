// Fills a compile-cache directory for THIS release, for deploy-remote.sh to run once at the release's final path:
//
//   MVP_COMPILE_CACHE_DIR=<release>/.compile-seed node <release>/dist/mvp/compileSeed.js
//
// It does what cli.ts does before it serves: enables the cache first, then loads the modules the engine loads at start (the
// config, the server and everything under it, telemetry, the PostHog glue), and exits 0, which is when Node writes its entries.
// It starts no server, reads no workspace and needs no environment beyond the cache directory. The engine copies the result into
// each workspace's own cache on its first start of the release (compileCache.ts, seedFromRelease).
import { enableWorkspaceCompileCache } from './compileCache';
const report = enableWorkspaceCompileCache();

try {
  if (!report.enabled) {
    console.error(`[compile-seed] not seeding: ${report.reason}`);
    process.exit(2);
  }
  // Plain requires, after the cache is on, for the same reason cli.ts enables it first: these are the heavy modules.
  for (const module of ['./config', './server', './telemetry', './posthogMcp']) require(module);
  console.log(`[compile-seed] loaded the startup modules into ${report.directory}`);
  process.exit(0);
} catch (err) {
  console.error('[compile-seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
