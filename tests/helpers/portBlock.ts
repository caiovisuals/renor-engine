import net from 'net';

/**
 * Loopback ports for a test that has to NAME the port itself: a fixture host's tenants, a gateway, the range a script walks.
 *
 * Two test runs on one machine (two gates, or a gate and someone's single file) must never hold the same port, and a fixed
 * number cannot promise that: the second run's engine fails to bind, and the first run's engine answers the second run's
 * probes. So each test PROCESS claims one block of ports and takes every port it names from that block:
 *
 *  - the block's first port is its lock: the claim is a listening socket on it, held until the process releases it or
 *    exits, so the kernel grants a block to one process at a time and takes it back when that process dies, however it dies;
 *  - the blocks sit below Linux's ephemeral range (32768-60999), where neither bind(0) nor an outgoing connection picks a
 *    port, so no other process on the machine lands in a block by chance;
 *  - a port something else holds anyway (an engine a killed run left behind, a service) is skipped, never assumed free.
 */

const FIRST_BLOCK = 20_000;
const BLOCK_SIZE = 64;
const BLOCK_COUNT = 128;

export interface PortBlock {
  /** The ports this process may use, both ends included. The port just below `first` is the block's lock. */
  first: number;
  last: number;
  /** Give the block back now instead of when the process exits. */
  release(): Promise<void>;
}

/** A server listening on 127.0.0.1:port, or null when the port is taken or may not be bound. */
function listenOn(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      server.unref();
      resolve(server);
    });
  });
}

const close = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** Claim a block no other process holds, trying the spot the pid picks first so concurrent runs rarely even meet. */
export async function claimPortBlock(): Promise<PortBlock> {
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const lock = FIRST_BLOCK + ((process.pid + i) % BLOCK_COUNT) * BLOCK_SIZE;
    const server = await listenOn(lock);
    if (server) return { first: lock + 1, last: lock + BLOCK_SIZE - 1, release: () => close(server) };
  }
  throw new Error(
    `no free port block in ${FIRST_BLOCK}-${FIRST_BLOCK + BLOCK_COUNT * BLOCK_SIZE - 1}: ${BLOCK_COUNT} test processes hold one each`,
  );
}

/** `count` ports in [first, last] that nothing listens on right now, lowest first. */
export async function freePorts(first: number, last: number, count: number): Promise<number[]> {
  const found: number[] = [];
  for (let port = first; port <= last && found.length < count; port++) {
    const probe = await listenOn(port);
    if (!probe) continue;
    await close(probe);
    found.push(port);
  }
  if (found.length < count) throw new Error(`only ${found.length} of the ${count} ports asked for are free in ${first}-${last}`);
  return found;
}
