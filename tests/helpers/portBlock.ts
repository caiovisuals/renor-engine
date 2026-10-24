import fs from 'fs';
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
 *  - the blocks sit below every ephemeral range the tests can meet, where neither bind(0) nor an outgoing connection picks a
 *    port, so no other process on the machine lands in a block by chance. A client socket whose source port is a block port
 *    makes listen() on that port fail with EADDRINUSE for as long as the connection lives and then for the 60 s of TIME_WAIT
 *    (measured, see the PR that moved the blocks), and a fixture engine that cannot bind stays alive and answers nothing.
 *    Linux's default range starts at 32768, but the range is not the same everywhere (netstack-based sandboxes hand out
 *    16000-65535, and /proc there can still say 32768), so the blocks sit below 16000 and below what /proc reports;
 *  - a port something else holds anyway (an engine a killed run left behind, a service) is skipped, never assumed free.
 */

/** The lowest port any platform the tests run on is known to hand out to outgoing connections (netstack's FirstEphemeral). */
const LOWEST_KNOWN_EPHEMERAL = 16_000;
/** Ports below this are the well-known and registered services' own. */
const LOWEST_BLOCK_PORT = 1_100;
const BLOCK_SIZE = 64;
const MAX_BLOCK_COUNT = 128;
const MIN_BLOCK_COUNT = 8;
const EPHEMERAL_RANGE_FILE = '/proc/sys/net/ipv4/ip_local_port_range';

/**
 * The ports blocks may sit in, given the first ephemeral port the kernel reports (null when it cannot be read): the top of
 * the space below every ephemeral range, `BLOCK_COUNT` blocks of it at most. Throws when too little room is left, instead of
 * handing out ports that an outgoing connection can take.
 */
export function blockRegion(kernelEphemeralLow: number | null): { first: number; count: number } {
  const ceiling = Math.min(LOWEST_KNOWN_EPHEMERAL, kernelEphemeralLow ?? LOWEST_KNOWN_EPHEMERAL);
  const count = Math.min(MAX_BLOCK_COUNT, Math.floor((ceiling - LOWEST_BLOCK_PORT) / BLOCK_SIZE));
  if (count < MIN_BLOCK_COUNT) {
    throw new Error(
      `the kernel hands out outgoing-connection ports from ${kernelEphemeralLow} up (${EPHEMERAL_RANGE_FILE}), which leaves room for ${Math.max(count, 0)} test port blocks below it ` +
        `(${MIN_BLOCK_COUNT} needed): a port a test names could be taken by any outgoing connection first. Raise the range's start, e.g. sysctl net.ipv4.ip_local_port_range="32768 60999".`,
    );
  }
  return { first: ceiling - count * BLOCK_SIZE, count };
}

function kernelEphemeralLow(): number | null {
  try {
    const low = Number(fs.readFileSync(EPHEMERAL_RANGE_FILE, 'utf8').trim().split(/\s+/)[0]);
    return Number.isInteger(low) && low > 0 ? low : null;
  } catch {
    return null; // no /proc: only the known-platform floor applies
  }
}

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
  const region = blockRegion(kernelEphemeralLow());
  for (let i = 0; i < region.count; i++) {
    const lock = region.first + ((process.pid + i) % region.count) * BLOCK_SIZE;
    const server = await listenOn(lock);
    if (server) return { first: lock + 1, last: lock + BLOCK_SIZE - 1, release: () => close(server) };
  }
  throw new Error(
    `no free port block in ${region.first}-${region.first + region.count * BLOCK_SIZE - 1}: ${region.count} test processes hold one each`,
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
