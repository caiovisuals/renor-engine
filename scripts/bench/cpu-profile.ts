import inspector from 'node:inspector';

/**
 * A V8 sampling profile (100 us interval) of the code between `start()` and `stop()`, for the benchmarks that take a
 * `--cpu-profile <file>`: they start it after their warm-up and stop it before they report, so start-up, migrations
 * and first-call compilation are not in it. Summarise the file with scripts/bench/cpuprofile-summary.ts. A profile run
 * is for finding where time goes, never for timing: sampling slows every call, so the milliseconds come from runs
 * without it.
 */
export class CpuProfile {
  private constructor(private readonly session: inspector.Session) {}

  static async start(): Promise<CpuProfile> {
    const session = new inspector.Session();
    session.connect();
    const profile = new CpuProfile(session);
    await profile.post('Profiler.enable');
    await profile.post('Profiler.setSamplingInterval', { interval: 100 });
    await profile.post('Profiler.start');
    return profile;
  }

  private post(method: string, params?: object): Promise<any> {
    return new Promise((resolve, reject) => this.session.post(method, params as any, (err, result) => (err ? reject(err) : resolve(result))));
  }

  /** The finished profile, in the `.cpuprofile` JSON shape. */
  async stop(): Promise<unknown> {
    const { profile } = await this.post('Profiler.stop');
    this.session.disconnect();
    return profile;
  }
}
