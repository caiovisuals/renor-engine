import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { claimPortBlock, freePorts, type PortBlock } from './portBlock';

/**
 * The port block (helpers/portBlock.ts) is what lets two test runs on one machine name ports without ever naming the same
 * one. These pin the three promises that rests on: a block belongs to one process at a time, it comes back when its holder
 * lets go, and a port something else holds is never handed out as free.
 */

const claimed: PortBlock[] = [];
const holders: net.Server[] = [];

async function claim(): Promise<PortBlock> {
  const block = await claimPortBlock();
  claimed.push(block);
  return block;
}

function hold(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(port, '127.0.0.1', () => {
      holders.push(server);
      resolve();
    });
  });
}

afterEach(async () => {
  for (const block of claimed.splice(0)) await block.release();
  await Promise.all(holders.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('claimPortBlock', () => {
  it('never hands one block to two claimers, even when both start from the same spot', async () => {
    // One process, so both claims start at the block its pid picks: the second can only get another block because the
    // first still holds the lock. Two processes meet at the same lock the same way.
    const first = await claim();
    const second = await claim();

    expect(second.first).not.toBe(first.first);
    expect(second.last < first.first || first.last < second.first).toBe(true);
    // The block's own lock is a held listener, which is why nobody else can take the block.
    await expect(freePorts(first.first - 1, first.first - 1, 1)).rejects.toThrow(/only 0 of the 1 ports/);
  });

  it('keeps its ports below the range the kernel hands out to bind(0) and to outgoing connections', async () => {
    const block = await claim();

    expect(block.first).toBeGreaterThanOrEqual(1024);
    expect(block.last).toBeLessThan(32768);
  });

  it('gives the block back when its holder lets go of it', async () => {
    const block = await claim();
    const { first, last } = block;
    await block.release();
    claimed.length = 0;

    const again = await claim();

    expect([again.first, again.last]).toEqual([first, last]);
  });
});

describe('freePorts', () => {
  it('skips a port something else holds, and says so when too few are left', async () => {
    const block = await claim();
    await hold(block.first + 1);

    expect(await freePorts(block.first, block.first + 3, 3)).toEqual([block.first, block.first + 2, block.first + 3]);
    await expect(freePorts(block.first, block.first + 1, 2)).rejects.toThrow(/only 1 of the 2 ports asked for are free/);
  });
});
