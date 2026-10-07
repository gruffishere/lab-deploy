// Serves exp/site_draft on 8140: the page, and the read server under /api (api.cjs).
// The RPC key lives in api.cjs's process only; nothing under /api returns it, and no page can reach a file outside this folder.
const http = require('http'), fs = require('fs'), path = require('path');
const { createReader, mount, clean } = require('./api.cjs');
const ROOT = __dirname, PORT = Number(process.env.PORT) || 8140;
const TYPE = { '.html':'text/html; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
               '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.mp4':'video/mp4' };

// last line of defence: log, never die, on anything a request handler failed to catch
process.on('unhandledRejection', e => console.log('⚠️ unhandled: ' + clean(e)));
process.on('uncaughtException', e => console.log('⚠️ uncaught: ' + clean(e)));

let reader = null, api = null;
try { reader = createReader(); api = mount(reader); } catch (e) { console.log('⚠️ read server off: ' + clean(e)); }
// the DASHBOARD is a sweep over every token (~15s cold): keep it warm so no visitor ever waits for it
if (reader) { const warm = () => reader.dashboard().catch(() => {}); setTimeout(warm, 3000); setInterval(warm, 55_000); }

http.createServer(async (req, res) => {
  // ⛔ a malformed %-escape throws here, and an exception in this async handler is an unhandled rejection,
  // which takes the whole Node process down: one bad link would have stopped the site for everyone
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400).end('bad request'); return; }
  if (rel.startsWith('/api/')) {
    if (api && await api(req, res, rel)) return;
    res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"read server off"}'); return;
  }
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  // ⛔ an ALLOW-list, not a deny-list (2026-10-07: the live check found node_modules and package.json readable).
  // Only the page, its two scripts, the machine assets, the fallback pieces and the flat data files are served.
  const relPath = path.relative(ROOT, file).split(path.sep).join('/');
  const ALLOWED = /^(index\.html|cells\.js|audit_layout\.js|audit_run\.js|(assets|art7)\/[\w.-]+|data\/[\w.-]+\.json)$/;
  if (!file.startsWith(ROOT + path.sep) || !ALLOWED.test(relPath)) { res.writeHead(403).end('no'); return; }
  /* ⛔ VIDEO NEEDS BYTE RANGES (gruff, 2026-10-07: no machine animation on his phone). iPhone Safari asks for an
     .mp4 in pieces (Range: bytes=…) and will not play one from a server that cannot answer 206 Partial Content.
     Desktop browsers forgave the whole-file 200; Safari does not. Videos are served in ranges, and cached. */
  if (path.extname(file) === '.mp4') {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
      if (!m) { res.writeHead(200, { ...head, 'Content-Length': st.size }); fs.createReadStream(file).pipe(res); return; }
      let a = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      let b = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }).end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': 'bytes ' + a + '-' + b + '/' + st.size, 'Content-Length': b - a + 1 });
      fs.createReadStream(file, { start: a, end: b }).pipe(res);
    });
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    // DISCOVER: the page arrives with this visit's seven already in it, so the first paint is the real art
    // and there is no extra round trip. Without the read server the page falls back to its own seven.
    if (file === path.join(ROOT, 'index.html') && reader)
      buf = Buffer.from(buf.toString('utf8').replace('/*@DISCOVER*/null', JSON.stringify(reader.discover())));
    // the page is never cached (it carries this visit's DISCOVER seven); the machine renders and data may be, for an hour
    res.writeHead(200, { 'Content-Type': TYPE[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': relPath === 'index.html' ? 'no-store' : 'public, max-age=3600' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('site draft on http://localhost:' + PORT + (reader ? '  (read server on)' : '')));
