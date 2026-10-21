import { describe, it, expect, afterEach } from 'vitest';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { poolFetch } from '../../src/net/poolFetch';
import { startVertexStub, type VertexStub } from '../helpers/vertexStub';

/**
 * A query embedded after a pause is asked over the connection the one before it opened. Node's own fetch closes a connection
 * that has been idle for 4 s, so the provider's plain `fetch` opened a new one (a new TCP and TLS connection to Google, on the
 * way of the read that is waiting for its query vector) whenever two reads were more than 4 s apart, which is how an agent
 * reads. The service gives its provider a pooled `request` (src/net/poolFetch.ts); a provider built without one is as it always
 * was. The stubs count the connections they accept, the token request included, and answer without a `Keep-Alive` hint as
 * Google's front end does. The first query may open more than one (the token and the predict follow each other without a
 * pause); what is pinned is whether the second opens another. Both providers wait out the same pause.
 */

const stubs: VertexStub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map(stub => stub.close()));
});

async function provider(request?: typeof fetch): Promise<{ vertex: VertexEmbeddingProvider; stub: VertexStub }> {
  const stub = await startVertexStub({ keepAliveHint: false });
  stubs.push(stub);
  return { vertex: new VertexEmbeddingProvider({ keyFile: stub.keyFile, project: 'stub-project', location: 'europe-west4', baseUrl: stub.baseUrl, request }), stub };
}

describe('VertexEmbeddingProvider connections', () => {
  it('embeds a second query 4.6 s after the first over the same connection when it is given a pooled request, and over a new one when it is not', async () => {
    const plain = await provider();
    const pooled = await provider(poolFetch({ retryOnReset: true }));
    for (const { vertex } of [plain, pooled]) expect(await vertex.embedQuery('what did we decide about the vector floor?')).toHaveLength(768);
    const opened = { plain: plain.stub.counts.connections, pooled: pooled.stub.counts.connections };
    expect(opened.plain).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 4_600));
    for (const { vertex } of [plain, pooled]) expect(await vertex.embedQuery('why did we choose that design?')).toHaveLength(768);
    expect(plain.stub.counts.served).toBe(2);
    expect(pooled.stub.counts.served).toBe(2);
    expect(plain.stub.counts.connections).toBe(opened.plain + 1); // the premise: the plain pool let its connection go
    expect(pooled.stub.counts.connections).toBe(opened.pooled);
  }, 20_000);
});
