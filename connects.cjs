// WHO CONNECTED: the page tells the server when a wallet connects, and this keeps the record (gruff, 2026-10-07:
// "kimler bağlandı görebileyim", read by the daily site check).
//   POST /api/hello      { address, wallet, device, how }   from the page, after a real connect (never ?wallet= views)
//   GET  /api/connects   header x-lab-key                    the record, for the daily check; 404 without the key
// The file sits next to the art cache: on Railway that is the /data volume, so it survives a deploy.
// ⛔ The record is private. Only a SHA-256 of the key is in this file; the key itself lives in onchain/.env.lab on
//    gruff's machine and never ships. Without the right key the route answers like a route that does not exist.
// What is kept per wallet: first and last connect, how many times, which wallet apps, phone or desktop, pieces held
// at the last connect. Plus the last 1,000 events in order. No IP, no user agent string.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const KEY_SHA = 'b74a66a85137d980e1648c7b5e783c259e4941222a081341f19a291601280ac9';
const MAX_WALLETS = 20000, MAX_EVENTS = 1000, SAME_VISIT_MS = 10 * 60 * 1000;

function createConnects(dir, piecesOf) {
  const file = path.join(dir, 'connects.json');
  let book = { wallets: {}, events: [] };
  try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let dirty = false;
  const save = () => {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(book)); fs.renameSync(file + '.tmp', file); }
    catch (e) { console.log('connects ⛔ not saved: ' + e.message); }
  };
  setInterval(save, 5000).unref();
  process.on('SIGTERM', () => { save(); process.exit(0); });

  // a page cannot be trusted, so the endpoint is cheap to abuse at most: 30 notes an hour per caller
  const seen = new Map();
  const tooMany = ip => { const now = Date.now(), r = (seen.get(ip) || []).filter(t => now - t < 3600e3); r.push(now); seen.set(ip, r); return r.length > 30; };

  async function hello(body, ip) {
    if (tooMany(ip)) return 429;
    const a = String(body.address || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return 400;
    const k = a.toLowerCase(), now = Date.now();
    const wallet = /^[\w.-]{1,40}$/.test(body.wallet || '') ? body.wallet : 'unknown';
    const device = body.device === 'phone' ? 'phone' : 'desktop';
    const how = ['connect', 'return', 'switch'].includes(body.how) ? body.how : 'connect';
    let pieces = null;
    try { pieces = await piecesOf(a); } catch {}
    let w = book.wallets[k];
    if (!w) {
      if (Object.keys(book.wallets).length >= MAX_WALLETS) return 507;
      w = book.wallets[k] = { first: now, last: 0, visits: 0, wallets: [], devices: [], pieces: null };
    }
    // the same wallet reloading the page within ten minutes is one visit, not many
    if (now - w.last > SAME_VISIT_MS) w.visits++;
    w.last = now;
    if (!w.wallets.includes(wallet)) w.wallets.push(wallet);
    if (!w.devices.includes(device)) w.devices.push(device);
    if (pieces != null) w.pieces = pieces;
    book.events.push({ t: now, a: k, wallet, device, how, pieces });
    if (book.events.length > MAX_EVENTS) book.events.splice(0, book.events.length - MAX_EVENTS);
    dirty = true;
    return 204;
  }

  const allowed = req => {
    const k = String(req.headers['x-lab-key'] || '');
    return k.length > 0 && crypto.createHash('sha256').update(k).digest('hex') === KEY_SHA;
  };

  return { hello, allowed, read: () => book };
}

module.exports = { createConnects };
