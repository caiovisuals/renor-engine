import net from 'net';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { MvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';

/**
 * A port nothing listens on right now. It is a hint, not a reservation: the probe closes its socket before the
 * caller binds, and on a host where sibling test files and other lanes' gates open sockets all day another process
 * can take the port in between. `startMvpServiceOnFreePort` is the way to start a service on one.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export type StartedMvpService = Awaited<ReturnType<typeof startMvpService>>;

/**
 * `startMvpService` on a probed port, started again on a fresh probe when the port was taken in between.
 *
 * Only EADDRINUSE is retried. `startMvpService` rejects with it when it cannot bind (it closes the database and the
 * boot rebuild it opened before rejecting, so a failed attempt leaves nothing behind), which makes a second attempt
 * safe; before it did, a test that lost the race went on talking to whoever answered on the port and failed with
 * "fetch failed", a 401, or another process's body. Any other error, and the last EADDRINUSE once the attempts are
 * used up, reaches the caller unchanged.
 *
 * `configFor` runs once per attempt, with the port of that attempt, because the settings a service reads (its port
 * and its base URL) are taken from the environment at that moment. A `provider` given as a function is called with
 * that attempt's config, for a provider built from the settings the service uses.
 */
export async function startMvpServiceOnFreePort(
  configFor: (port: number) => MvpConfig,
  provider?: EmbeddingProvider | null | ((config: MvpConfig) => EmbeddingProvider | null),
  { attempts = 5, pickPort = freePort }: { attempts?: number; pickPort?: () => Promise<number> } = {},
): Promise<{ started: StartedMvpService; config: MvpConfig; port: number }> {
  let lastTaken: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await pickPort();
    const config = configFor(port);
    try {
      return { started: await startMvpService(config, typeof provider === 'function' ? provider(config) : provider), config, port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
      lastTaken = err;
    }
  }
  throw lastTaken;
}
