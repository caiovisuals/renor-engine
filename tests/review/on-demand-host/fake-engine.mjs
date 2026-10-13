// A tenant engine as the on-demand admission tests need it, and nothing more: started by the fixture
// systemctl with the tenant's own env file, it answers the loopback probes the worker and the gateway
// make (GET /version, POST /internal/gateway-token) and a proxied POST /mcp on MVP_PORT, and exits 0
// on SIGTERM.
//
// ODA_BOOT_MS delays the bind, like a cold start. If the port is already taken it stays ALIVE without
// listening — the window in which systemd reports a unit active while something else answers on its
// port, which is exactly what the worker's "nothing answers once it has stopped" check must catch.
import http from 'node:http';

const port = Number(process.env.MVP_PORT);
const slug = process.env.MVP_INSTANCE_ID ?? 'unknown';
const secret = process.env.MVP_GATEWAY_SECRET ?? '';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instance: slug }));
    return;
  }
  if (req.method === 'POST' && req.url === '/internal/gateway-token') {
    if (req.headers['x-renor-gateway-secret'] !== secret) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: `backend-${slug}` }));
    return;
  }
  if (req.method === 'POST' && req.url === '/mcp') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tenant: slug, authorization: req.headers.authorization ?? null }));
    return;
  }
  res.writeHead(404).end();
});

server.on('error', (err) => {
  console.error(`[fake-engine ${slug}] ${err.code ?? err.message}: not listening on ${port}`);
});
setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.ODA_BOOT_MS ?? 0));
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
setInterval(() => {}, 1 << 30); // stay alive even when the bind failed
