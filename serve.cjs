// Serves exp/site_draft on 8140: the page, and the read server under /api (api.cjs).
// The RPC key lives in api.cjs's process only; nothing under /api returns it, and no page can reach a file outside this folder.
const http = require('http'), fs = require('fs'), path = require('path');
const { createReader, mount, clean } = require('./api.cjs');
const ROOT = __dirname, PORT = Number(process.env.PORT) || 8140;
const TYPE = { '.html':'text/html; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
               '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.mp4':'video/mp4' };

let reader = null, api = null;
try { reader = createReader(); api = mount(reader); } catch (e) { console.log('⚠️ read server off: ' + clean(e)); }
// the DASHBOARD is a sweep over every token (~15s cold): keep it warm so no visitor ever waits for it
if (reader) { const warm = () => reader.dashboard().catch(() => {}); setTimeout(warm, 3000); setInterval(warm, 55_000); }

http.createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/api/')) {
    if (api && await api(req, res, rel)) return;
    res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"read server off"}'); return;
  }
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  // never serve outside the draft folder, and never the server's own code or its cache
  if (!file.startsWith(ROOT + path.sep) || /\.cjs$/.test(file) || file.startsWith(path.join(ROOT, 'cache'))) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    // DISCOVER: the page arrives with this visit's seven already in it, so the first paint is the real art
    // and there is no extra round trip. Without the read server the page falls back to its own seven.
    if (file === path.join(ROOT, 'index.html') && reader)
      buf = Buffer.from(buf.toString('utf8').replace('/*@DISCOVER*/null', JSON.stringify(reader.discover())));
    res.writeHead(200, { 'Content-Type': TYPE[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('site draft on http://localhost:' + PORT + (reader ? '  (read server on)' : '')));
