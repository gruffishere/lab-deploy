// THE LAB read server (2026-10-06). Holds the RPC key, reads mainnet, caches the art.
//
// The browser never talks to the chain for reads. Three reasons:
//   1. the RPC key stays here, never in a page
//   2. a render is a multi-million gas eth_call; the art is cached on disk, keyed by the owner it was drawn for
//      (POSE and HUE come from the REAL owner, so a transfer changes the piece and invalidates the cache)
//   3. "which tokens does this wallet hold" has no on-chain index and Alchemy serves no eth_getLogs here, so the
//      server keeps an owner index of every id, swept with Multicall3 every OWNER_TTL ms
//
// Routes, all GET, all JSON except /art:
//   /api/health              block, seed, supply, owner index age
//   /api/collection          supply, holders, facet counts, motion default, forge state, the TURN pool and threshold
//   /api/discover            seven tokens, one per facet, drawn at random from the 56-token pool
//   /api/wallet/<address>    every token the address holds, with name, facet, attributes, clock, tickets, motion
//   /api/token/<id>          one token, same shape, plus its owner
//   /api/art/<id>.svg        the chain svg (animated if the token moves); ?still=1 for the static one
//
// Art lookup order: site_draft/cache/art (written here) → review/chain_snapshot (read only, local) → the chain.
// A cached file is used only when it was drawn for the token's CURRENT owner.
'use strict';
const fs = require('fs'), path = require('path');
const EXP = path.join(__dirname, '..');
const ethers = (() => { try { return require('ethers'); } catch { return require(path.join(EXP, 'onchain_proto', 'node_modules', 'ethers')); } })();

// ⛔ The RPC URL carries the key. It comes from the environment (hosting) or from RPC_URL in .env.mainnet
//    (this machine). Nothing else is read from that file, and the URL is never logged or sent to a page.
function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL.trim();
  try {
    const env = fs.readFileSync(path.join(EXP, 'onchain', '.env.mainnet'), 'utf8');
    return ((env.match(/^RPC_URL=(.+)$/m) || [])[1] || '').trim();
  } catch { return ''; }
}
const clean = e => String((e && (e.reason || e.code || e.message)) || e).split('\n')[0].replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 160);

// contract addresses: the deploy package carries data/contracts.json; on this machine the mainnet manifest
const M = fs.existsSync(path.join(__dirname, 'data', 'contracts.json'))
  ? require(path.join(__dirname, 'data', 'contracts.json'))
  : require(path.join(EXP, 'onchain', 'deploy_sepolia.manifest.1.json'));
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const FIDX = { COLLECTOR: 0, NEWBIE: 1, DEGEN: 2, BUILDER: 3, OG: 4, WHALE: 5, GHOST: 6 };
const OWNER_TTL = 60_000, LIGHT_TTL = 30_000, BATCH = 400;
const ART_DIR = process.env.ART_DIR || path.join(__dirname, 'cache', 'art');
// the 10-04 chain snapshot: shipped inside the deploy package as data/snapshot, read in place on this machine
const SNAP_DIR = process.env.SNAP_DIR || (fs.existsSync(path.join(__dirname, 'data', 'snapshot')) ? path.join(__dirname, 'data', 'snapshot') : path.join(EXP, 'review', 'chain_snapshot'));
// fixed at reveal: id → facet and name, and the DISCOVER pool (build_index.cjs writes both)
const INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'facets.json'), 'utf8'));
const POOL = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'discover.json'), 'utf8'));
const FACET_COUNT = {}; for (const [, f] of INDEX.tokens) FACET_COUNT[f] = (FACET_COUNT[f] || 0) + 1;
const BY_ID = new Map(INDEX.tokens.map(([id, facet, name]) => [id, { id, facet, name }]));
// how many pieces carry each trait value (build_index.cjs, from the core's metadata; fixed since reveal)
const TRAITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'traits.json'), 'utf8'));
const ATTRS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'attrs.json'), 'utf8'));
// the two wallets of the project itself. gruff, 2026-10-07: listed, marked in brackets, never ranked
const LABELS = {
  '0x4730497622bdfd6eafe1f09fa22b3a0aca94a646': 'ARTIST',
  '0x0cb8f1f4531e1685694a4a3f71a6cb7ca455e067': 'TREASURY',
};

const CORE_ABI = ['function tokenURI(uint256) view returns (string)', 'function ownerOf(uint256) view returns (address)',
  'function totalMinted() view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function revealed() view returns (bool)',
  'function revealSeed() view returns (bytes32)', 'function nameSupply() view returns (uint256)', 'function renderer() view returns (address)',
  'function namesPointer() view returns (address)', 'function defaultAnimated() view returns (bool)', 'function forgeOpen() view returns (bool)',
  'function heldSince(uint256) view returns (uint64)', 'function motionOf(uint256) view returns (bool)', 'function isForged(uint256) view returns (bool)'];
const TURN_ABI = ['function pool() view returns (uint256)', 'function currentThreshold() view returns (uint256)', 'function started() view returns (bool)',
  'function turnsDone() view returns (uint256)', 'function nextTurnAt() view returns (uint256)', 'function ticketsOf(uint256) view returns (uint256)',
  'function excluded(address) view returns (bool)'];
const MC_ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])'];
const ENTRY_IF = new ethers.utils.Interface(['function tokenURI(uint256,address,uint8,bool,bool,bool,address,uint32,uint256) view returns (string)']);

const dec = s => s.startsWith('data:image/svg+xml;base64,') ? Buffer.from(s.slice(26), 'base64').toString('utf8') : decodeURIComponent(s.slice(s.indexOf(',') + 1));
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function createReader() {
  const url = rpcUrl();
  if (!url) throw new Error('no RPC_URL (set the env var, or RPC_URL= in onchain/.env.mainnet)');
  const pr = new ethers.providers.StaticJsonRpcProvider(url, 1);
  const core = new ethers.Contract(M.core, CORE_ABI, pr), turn = new ethers.Contract(M.turn, TURN_ABI, pr);
  const mc = new ethers.Contract(MULTICALL3, MC_ABI, pr);
  let fixed = null;                     // things that never change after reveal: seed, supply, entry, names book
  let owners = null, ownersAt = 0, ownersBlock = 0, ownersJob = null;
  let coll = null, collAt = 0;
  const light = new Map();              // id → { at, heldSince, tickets, motion }
  const artJobs = new Map();            // id → in-flight render promise, so two visitors never pay for one render twice
  let renderSlots = 4; const renderQueue = [];   // 4 at once: ACTIVITY draws two stills per row

  async function init() {
    if (fixed) return fixed;
    const [revealed, rs, ns, entry, names] = await Promise.all([core.revealed(), core.revealSeed(), core.nameSupply(), core.renderer(), core.namesPointer()]);
    if (!revealed) throw new Error('not revealed');
    fixed = { revealSeed: rs, seed: Number(BigInt(rs) & 0xffffffffn), supply: ns.toNumber(), entry, names };
    return fixed;
  }

  // Multicall3 over a list of (target, calldata); failures come back as null instead of throwing.
  async function multi(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += BATCH) {
      const part = calls.slice(i, i + BATCH);
      const res = await mc.aggregate3(part.map(([t, d]) => ({ target: t, allowFailure: true, callData: d })));
      for (const r of res) out.push(r.success ? r.returnData : null);
    }
    return out;
  }

  // The owner of every id ever minted. Burned ids (a forge input) revert in ownerOf and come back null.
  async function ownerIndex() {
    if (owners && Date.now() - ownersAt < OWNER_TTL) return owners;
    if (ownersJob) return ownersJob;
    ownersJob = (async () => {
      const [minted, block] = await Promise.all([core.totalMinted(), pr.getBlockNumber()]);
      const n = minted.toNumber(), ids = Array.from({ length: n }, (_, i) => i + 1);
      const res = await multi(ids.map(id => [M.core, core.interface.encodeFunctionData('ownerOf', [id])]));
      const next = new Array(n + 1).fill(null);
      res.forEach((r, i) => { if (r) next[i + 1] = core.interface.decodeFunctionResult('ownerOf', r)[0]; });
      owners = next; ownersAt = Date.now(); ownersBlock = block;
      return owners;
    })().finally(() => { ownersJob = null; });
    return ownersJob;
  }

  async function collection() {
    if (coll && Date.now() - collAt < LIGHT_TTL) return coll;
    const f = await init();
    const [minted, supply, defaultAnimated, forgeOpen, pool, threshold, started, turnsDone, nextTurnAt, block] = await Promise.all([
      core.totalMinted(), core.totalSupply(), core.defaultAnimated(), core.forgeOpen(),
      turn.pool(), turn.currentThreshold(), turn.started(), turn.turnsDone(), turn.nextTurnAt(), pr.getBlockNumber()]);
    const own = await ownerIndex();
    coll = { block, supply: supply.toNumber(), minted: minted.toNumber(), nameSupply: f.supply, revealed: true,
      holders: new Set(own.filter(Boolean).map(a => a.toLowerCase())).size, facets: FACET_COUNT,
      defaultAnimated, forgeOpen,
      turn: { pool: ethers.utils.formatEther(pool), threshold: ethers.utils.formatEther(threshold), started, turnsDone: turnsDone.toNumber(),
        nextTurnAt: nextTurnAt.toNumber() } };
    collAt = Date.now();
    return coll;
  }

  // heldSince / ticketsOf / motionOf for many ids in one round trip.
  async function lightFor(ids) {
    const need = ids.filter(id => { const l = light.get(id); return !l || Date.now() - l.at > LIGHT_TTL; });
    if (need.length) {
      const calls = [];
      for (const id of need) calls.push([M.core, core.interface.encodeFunctionData('heldSince', [id])],
        [M.turn, turn.interface.encodeFunctionData('ticketsOf', [id])], [M.core, core.interface.encodeFunctionData('motionOf', [id])]);
      const res = await multi(calls);
      need.forEach((id, i) => {
        const [h, t, m] = res.slice(i * 3, i * 3 + 3);
        light.set(id, { at: Date.now(),
          heldSince: h ? core.interface.decodeFunctionResult('heldSince', h)[0].toNumber() : null,
          tickets: t ? turn.interface.decodeFunctionResult('ticketsOf', t)[0].toNumber() : null,
          motion: m ? core.interface.decodeFunctionResult('motionOf', m)[0] : null });
      });
    }
    return ids.map(id => { const { at, ...rest } = light.get(id); return rest; });
  }

  // ── the art ──────────────────────────────────────────────────────────────────────────────────────────
  const artPaths = (dir, id) => ({ json: path.join(dir, id + '.json'), anim: path.join(dir, id + '.anim.svg'), still: path.join(dir, id + '.static.svg') });
  function readCached(dir, id, owner) {
    const p = artPaths(dir, id);
    try {
      const meta = JSON.parse(fs.readFileSync(p.json, 'utf8'));
      if (!sameAddr(meta.owner, owner) || !fs.existsSync(p.anim) || !fs.existsSync(p.still)) return null;
      return { meta, paths: p };
    } catch { return null; }
  }
  async function withSlot(fn) {
    if (renderSlots === 0) await new Promise(r => renderQueue.push(r));
    renderSlots--;
    try { return await fn(); } finally { renderSlots++; const n = renderQueue.shift(); if (n) n(); }
  }
  // Same two reads chain_snapshot.cjs makes: the CORE's tokenURI (what OpenSea indexes) and the live entry with
  // animated=false and the real owner (the still). The still must agree with the core on name and attributes.
  async function renderFromChain(id, owner) {
    const f = await init();
    return withSlot(async () => {
      const u = await core.tokenURI(id);
      const j = JSON.parse(decodeURIComponent(u.slice(u.indexOf(',') + 1)));
      const facet = String((j.attributes.find(a => a.trait_type === 'Facet') || {}).value || '').toUpperCase();
      if (!(facet in FIDX)) throw new Error('no facet on #' + id);
      if (await core.isForged(id)) throw new Error('#' + id + ' is forged; the forge path is not served yet');
      // ⛔ The CORE's own special rolls (FacetsCore._alloc): keccak over the FULL revealSeed, never the JS vomitOf/ghostGrailOf.
      const kv = k => ethers.BigNumber.from(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256', 'uint256'], [f.revealSeed, id, k]))).mod(10000).toNumber();
      const isVomit = kv(1) < 12, isGrail = facet === 'GHOST' && kv(2) < 33;
      const d = ENTRY_IF.encodeFunctionData('tokenURI', [id, owner, FIDX[facet], isVomit, isGrail, false, f.names, f.seed, f.supply]);
      const [su] = ENTRY_IF.decodeFunctionResult('tokenURI', await pr.call({ to: f.entry, data: d }));
      const sj = JSON.parse(decodeURIComponent(su.slice(su.indexOf(',') + 1)));
      if (sj.name !== j.name || JSON.stringify(sj.attributes) !== JSON.stringify(j.attributes)) throw new Error('still disagrees with the core on #' + id);
      const anim = dec(j.animation_url || j.image), still = dec(sj.image);
      const block = await pr.getBlockNumber();
      const meta = { id, name: j.name, attributes: j.attributes, owner, animated: /@keyframes/.test(anim), block };
      fs.mkdirSync(ART_DIR, { recursive: true });
      const p = artPaths(ART_DIR, id);
      fs.writeFileSync(p.anim, anim); fs.writeFileSync(p.still, still); fs.writeFileSync(p.json, JSON.stringify(meta));
      return { meta, paths: p };
    });
  }
  async function art(id) {
    const own = await ownerIndex();
    const owner = own[id];
    if (!owner) return null;
    const hit = readCached(ART_DIR, id, owner) || readCached(SNAP_DIR, id, owner);
    if (hit) return hit;
    if (!artJobs.has(id)) artJobs.set(id, renderFromChain(id, owner).finally(() => artJobs.delete(id)));
    return artJobs.get(id);
  }

  /* ══ ACTIVITY (2026-10-07): every transfer of the collection, newest first, live ═════════════════
     History comes from alchemy_getAssetTransfers: this plan caps eth_getLogs at 10 blocks, but the
     transfers API serves the whole range. It is loaded once, then topped up every ACT_TTL from the
     last block seen. A SALE is not a field of a transfer: it is measured from the transaction, as the
     ETH the buyer sent (tx.from == the new owner) or the WETH the new owner paid out in the receipt
     (an accepted offer), split evenly over the FACETS that moved to that buyer in the same tx.
     Without a payment it is a TRANSFER; from the zero address it is a MINT. */
  const ZERO = '0x0000000000000000000000000000000000000000';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ACT_TTL = 20_000;
  let acts = [], actsBlock = 0, actsAt = 0, actsJob = null;
  const SALES_FILE = path.join(ART_DIR, '..', 'sales.json');
  const sales = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8')); } catch { return {}; } })()));
  const rowOf = t => ({ key: t.uniqueId, hash: t.hash, block: parseInt(t.blockNum, 16),
    time: t.metadata && t.metadata.blockTimestamp, id: parseInt(t.erc721TokenId || (t.tokenId || '0x0'), 16),
    from: t.from, to: t.to, kind: t.from === ZERO ? 'mint' : (t.to === ZERO ? 'burn' : 'transfer') });
  async function pullTransfers(fromBlock, order) {
    const out = []; let pageKey;
    do {
      const r = await pr.send('alchemy_getAssetTransfers', [{ fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest',
        contractAddresses: [M.core], category: ['erc721'], order, withMetadata: true, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }]);
      out.push(...r.transfers.map(rowOf)); pageKey = r.pageKey;
    } while (pageKey);
    return out;
  }
  async function activityRows() {
    if (acts.length && Date.now() - actsAt < ACT_TTL) return acts;
    if (actsJob) return actsJob;
    actsJob = (async () => {
      if (!acts.length) acts = await pullTransfers(0, 'desc');
      else {
        const fresh = (await pullTransfers(actsBlock, 'asc')).filter(r => !acts.some(a => a.key === r.key));
        acts = fresh.reverse().concat(acts);
      }
      actsBlock = acts.length ? acts[0].block : 0; actsAt = Date.now();
      resolveSalesInBackground();
      return acts;
    })().finally(() => { actsJob = null; });
    return actsJob;
  }
  async function saleOf(row) {
    if (row.kind !== 'transfer') return null;
    if (sales.has(row.hash)) { const s = sales.get(row.hash); return s && s[row.to] ? { eth: s[row.to].eth, unit: s[row.to].unit, n: s[row.to].n } : null; }
    const [tx, rc] = await Promise.all([pr.getTransaction(row.hash), pr.getTransactionReceipt(row.hash)]);
    // every FACETS that moved in this tx, per buyer
    const moved = {};
    for (const l of rc.logs) if (l.address.toLowerCase() === M.core.toLowerCase() && l.topics[0] === TRANSFER_TOPIC) {
      const to = '0x' + l.topics[2].slice(26); moved[to] = (moved[to] || 0) + 1;
    }
    const per = {};
    for (const [buyer, n] of Object.entries(moved)) {
      let wei = 0n, unit = null;
      if (tx.from.toLowerCase() === buyer && !tx.value.isZero()) { wei = BigInt(tx.value.toString()); unit = 'ETH'; }
      else {
        for (const l of rc.logs) if (l.address.toLowerCase() === WETH && l.topics[0] === TRANSFER_TOPIC && ('0x' + l.topics[1].slice(26)) === buyer)
          wei += BigInt(l.data);
        if (wei > 0n) unit = 'WETH';
      }
      if (unit) per[buyer] = { eth: Number(wei / BigInt(n)) / 1e18, unit, n };
    }
    sales.set(row.hash, per);
    return per[row.to] ? { eth: per[row.to].eth, unit: per[row.to].unit, n: per[row.to].n } : null;
  }
  let salesBusy = false;
  async function resolveSalesInBackground() {
    if (salesBusy) return; salesBusy = true;
    try {
      const todo = acts.filter(r => r.kind === 'transfer' && !sales.has(r.hash));
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(r => saleOf(r).catch(() => null)));
        if (i % 40 === 0) { fs.mkdirSync(path.dirname(SALES_FILE), { recursive: true }); fs.writeFileSync(SALES_FILE, JSON.stringify(Object.fromEntries(sales))); }
      }
      fs.mkdirSync(path.dirname(SALES_FILE), { recursive: true }); fs.writeFileSync(SALES_FILE, JSON.stringify(Object.fromEntries(sales)));
    } finally { salesBusy = false; }
  }
  // the piece as it draws for ANY holder: the still through the live entry with that owner (pose and hue follow it)
  const ownerJobs = new Map();
  async function stillFor(id, owner) {
    const f = await init(), file = path.join(ART_DIR, 'own', id + '-' + owner.toLowerCase() + '.svg');
    if (fs.existsSync(file)) return file;
    const snap = readCached(SNAP_DIR, id, owner) || readCached(ART_DIR, id, owner);
    if (snap) return snap.paths.still;
    const k = id + owner.toLowerCase();
    if (!ownerJobs.has(k)) ownerJobs.set(k, withSlot(async () => {
      const t = BY_ID.get(id); if (!t) throw new Error('no such token');
      const kv = n => ethers.BigNumber.from(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256', 'uint256'], [f.revealSeed, id, n]))).mod(10000).toNumber();
      const d = ENTRY_IF.encodeFunctionData('tokenURI', [id, owner, FIDX[t.facet], kv(1) < 12, t.facet === 'GHOST' && kv(2) < 33, false, f.names, f.seed, f.supply]);
      const [su] = ENTRY_IF.decodeFunctionResult('tokenURI', await pr.call({ to: f.entry, data: d }));
      const sj = JSON.parse(decodeURIComponent(su.slice(su.indexOf(',') + 1)));
      if (sj.name !== t.name) throw new Error('render disagrees with the index on #' + id);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dec(sj.image));
      return file;
    }).finally(() => ownerJobs.delete(k)));
    return ownerJobs.get(k);
  }
  async function activity({ kind = 'all', addr = null, id = null, before = null, limit = 24 }) {
    const rows = await activityRows();
    let i = before ? rows.findIndex(r => r.key === before) + 1 : 0;
    const out = [];
    const a = addr && addr.toLowerCase();
    for (; i < rows.length && out.length < limit; i++) {
      const r = rows[i];
      if (a && r.from !== a && r.to !== a) continue;
      if (id && r.id !== id) continue;
      if (kind === 'mint' && r.kind !== 'mint') continue;
      if ((kind === 'transfer' || kind === 'sale') && r.kind !== 'transfer') continue;
      let sale = null;
      if (r.kind === 'transfer') sale = sales.has(r.hash) ? (sales.get(r.hash)[r.to] || null) : await saleOf(r).catch(() => null);
      if (kind === 'sale' && !sale) continue;
      if (kind === 'transfer' && sale) continue;
      const t = BY_ID.get(r.id) || {};
      out.push({ ...r, name: t.name || null, facet: t.facet || null, sale: sale && { eth: sale.eth, unit: sale.unit, n: sale.n } });
    }
    // names for the wallets on this page: from the ENS cache now, looked up in the background for next time
    const ens = {};
    for (const r of out) for (const w of [r.from, r.to]) if (w !== ZERO) {
      const hit = ensCache.get(w); if (hit) ens[w] = hit.name; else ensOf(w).catch(() => {});
    }
    return { rows: out, ens, next: out.length === limit ? out[out.length - 1].key : null, newest: rows[0] && rows[0].key,
             total: rows.length, salesResolved: rows.filter(r => r.kind === 'transfer' && sales.has(r.hash)).length,
             transfers: rows.filter(r => r.kind === 'transfer').length };
  }

  /* ══ DASHBOARD (2026-10-07): the holders, the pulse, the seven buckets of THE TURN ═══════════════
     Everything from the chain: owners (the index), heldSince / ticketsOf (multicall over every id),
     excluded() on THE TURN for every holder, sales from the measured ACTIVITY, traits from attrs.json.
     ⛔ The bucket totals count only tickets that can WIN: a wallet THE TURN excludes is left out of them,
     read from the contract, not assumed (the treasury's exclusion was still unsent on 2026-10-01). */
  let dash = null, dashAt = 0, dashJob = null;
  const DASH_TTL = 60_000;
  async function dashboard() {
    if (dash && Date.now() - dashAt < DASH_TTL) return dash;
    if (dashJob) return dashJob;
    dashJob = (async () => {
      const own = await ownerIndex();
      const ids = []; own.forEach((o, id) => { if (o) ids.push(id); });
      const [light, rows] = await Promise.all([lightFor(ids), activityRows()]);
      const L = new Map(ids.map((id, i) => [id, light[i]]));
      // the holders
      const H = new Map();
      for (const id of ids) {
        const k = own[id].toLowerCase(), t = BY_ID.get(id) || {}, l = L.get(id) || {};
        let h = H.get(k); if (!h) H.set(k, h = { address: own[id], pieces: 0, facets: {}, tickets: 0, oldest: null, rarest: null });
        h.pieces++; h.facets[t.facet] = (h.facets[t.facet] || 0) + 1; h.tickets += l.tickets || 0;
        if (l.heldSince && (!h.oldest || l.heldSince < h.oldest)) h.oldest = l.heldSince;
        for (const [tt, v] of (ATTRS[id] || [])) {
          const n = TRAITS.counts[tt] && TRAITS.counts[tt][v];
          if (n && (!h.rarest || n < h.rarest.n)) h.rarest = { trait: tt, value: v, n, id };
        }
      }
      const addrs = [...H.keys()];
      const ex = await multi(addrs.map(a => [M.turn, turn.interface.encodeFunctionData('excluded', [a])]));
      addrs.forEach((a, i) => { H.get(a).excluded = ex[i] ? turn.interface.decodeFunctionResult('excluded', ex[i])[0] : null; });
      const list = [...H.values()].map(h => ({ ...h, label: LABELS[h.address.toLowerCase()] || null }))
        .sort((a, b) => b.pieces - a.pieces || b.tickets - a.tickets);
      let r = 0, prev = null, shown = 0;
      for (const h of list) { if (h.label) { h.rank = null; continue; } shown++; if (h.pieces !== prev) { r = shown; prev = h.pieces; } h.rank = r; }
      // the pulse
      const ranked = list.filter(h => !h.label);
      const dist = { one: 0, few: 0, many: 0, lots: 0 };
      for (const h of ranked) h.pieces === 1 ? dist.one++ : h.pieces <= 5 ? dist.few++ : h.pieces <= 20 ? dist.many++ : dist.lots++;
      const saleRows = rows.filter(x => x.kind === 'transfer' && sales.has(x.hash) && sales.get(x.hash)[x.to]);
      const vol = saleRows.reduce((a, x) => a + sales.get(x.hash)[x.to].eth, 0);
      const last = saleRows[0];
      const full = ranked.filter(h => Object.keys(h.facets).length === 7).length;
      // the seven buckets: pieces, holders, and the tickets that can actually be drawn
      const buckets = {};
      for (const f of Object.keys(FACET_COUNT)) buckets[f] = { pieces: 0, holders: 0, tickets: 0, excludedTickets: 0 };
      for (const id of ids) {
        const f = (BY_ID.get(id) || {}).facet, h = H.get(own[id].toLowerCase()), tk = (L.get(id) || {}).tickets || 0;
        if (!buckets[f]) continue; buckets[f].pieces++; h.excluded ? (buckets[f].excludedTickets += tk) : (buckets[f].tickets += tk);
      }
      for (const h of list) for (const f of Object.keys(h.facets)) if (buckets[f]) buckets[f].holders++;
      dash = { block: ownersBlock, at: new Date().toISOString(),
        pulse: { holders: ranked.length, pieces: ids.length, fullSet: full, dist,
                 sales: saleRows.length, volume: vol, avg: saleRows.length ? vol / saleRows.length : 0,
                 last: last ? { id: last.id, eth: sales.get(last.hash)[last.to].eth, unit: sales.get(last.hash)[last.to].unit, time: last.time } : null },
        buckets, holders: list };
      for (const h of list) { const hit = ensCache.get(h.address.toLowerCase()); h.ens = hit ? hit.name : undefined; }
      // names for everyone, quietly, a few at a time; the next refresh carries them
      (async () => { for (const h of list) if (!ensCache.has(h.address.toLowerCase())) { await ensOf(h.address).catch(() => {}); } })();
      dashAt = Date.now();
      return dash;
    })().finally(() => { dashJob = null; });
    return dashJob;
  }

  // ENS: the primary name, which ethers v5 only returns when it also resolves forward to the same
  // address, so a name someone merely pointed at you does not show. Cached for an hour, misses included.
  const ensCache = new Map();
  async function ensOf(addr) {
    const k = addr.toLowerCase(), hit = ensCache.get(k);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.name;
    let name = null;
    try { name = await pr.lookupAddress(ethers.utils.getAddress(k)); } catch { name = null; }
    ensCache.set(k, { at: Date.now(), name });
    return name;
  }

  const shape = (a, l) => ({ id: a.meta.id, name: a.meta.name,
    facet: (a.meta.attributes.find(x => x.trait_type === 'Facet') || {}).value || null,
    attributes: a.meta.attributes, animated: a.meta.animated, ...l });

  return {
    async health() {
      const f = await init(); const own = await ownerIndex();
      return { ok: true, seed: '0x' + f.seed.toString(16), nameSupply: f.supply, ownerIndexBlock: ownersBlock,
        ownerIndexAgeSec: Math.round((Date.now() - ownersAt) / 1000), held: own.filter(Boolean).length };
    },
    collection,
    // DISCOVER: one token per facet, drawn fresh from the pool on every call
    discover() {
      return Object.keys(POOL).map(f => BY_ID.get(POOL[f][Math.floor(Math.random() * POOL[f].length)]));
    },
    async wallet(addr) {
      const own = await ownerIndex();
      const ids = []; own.forEach((o, id) => { if (sameAddr(o, addr)) ids.push(id); });
      const [l, arts, ens] = await Promise.all([lightFor(ids), Promise.all(ids.map(art)), ensOf(addr)]);
      // where this wallet stands among holders by pieces held: 1 + the holders holding strictly more
      // the project's own wallets are marked, not ranked, and do not count among the holders they would outrank
      const per = new Map(); for (const o of own) if (o) { const k = o.toLowerCase(); per.set(k, (per.get(k) || 0) + 1); }
      const label = LABELS[addr.toLowerCase()] || null;
      const ranked = [...per.entries()].filter(([k]) => !LABELS[k]).map(([, n]) => n);
      const rank = ids.length && !label ? 1 + ranked.filter(n => n > ids.length).length : null;
      return { address: ethers.utils.getAddress(addr.toLowerCase()), ens, block: ownersBlock, count: ids.length,
        rank, holders: ranked.length, label,
        tokens: ids.map((id, i) => shape(arts[i], l[i])) };
    },
    async token(id) {
      const own = await ownerIndex();
      if (!own[id]) return null;
      const [[l], a] = await Promise.all([lightFor([id]), art(id)]);
      return { ...shape(a, l), owner: own[id] };
    },
    activity, stillFor, dashboard,
    async artFile(id, still) { const a = await art(id); return a ? (still ? a.paths.still : a.paths.anim) : null; },
    // for the verify script only
    _internals: { pr, core, turn, ownerIndex },
  };
}

// HTTP glue. Returns true when it handled the request.
function mount(reader) {
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async (req, res, rel) => {
    if (!rel.startsWith('/api/')) return false;
    if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }); return true; }
    try {
      let m;
      if (rel === '/api/health') json(res, 200, await reader.health());
      else if (rel === '/api/discover') json(res, 200, reader.discover());
      else if (rel === '/api/traits') json(res, 200, TRAITS);
      else if (rel === '/api/dashboard') json(res, 200, await reader.dashboard());
      else if (rel === '/api/collection') json(res, 200, await reader.collection());
      else if ((m = rel.match(/^\/api\/wallet\/(0x[0-9a-fA-F]{40})$/))) json(res, 200, await reader.wallet(m[1]));
      else if ((m = rel.match(/^\/api\/token\/(\d{1,5})$/))) {
        const t = await reader.token(Number(m[1]));
        t ? json(res, 200, t) : json(res, 404, { error: 'no such token' });
      } else if (rel === '/api/activity') {
        const q = new URL(req.url, 'http://x').searchParams;
        const kind = ['all', 'sale', 'transfer', 'mint'].includes(q.get('kind')) ? q.get('kind') : 'all';
        const addr = /^0x[0-9a-fA-F]{40}$/.test(q.get('addr') || '') ? q.get('addr') : null;
        const id = /^\d{1,5}$/.test(q.get('id') || '') ? Number(q.get('id')) : null;
        const before = /^0x[0-9a-f]{64}:log:\d+$/i.test(q.get('before') || '') ? q.get('before') : null;
        json(res, 200, await reader.activity({ kind, addr, id, before, limit: 24 }));
      } else if ((m = rel.match(/^\/api\/art\/(\d{1,5})\.svg$/))) {
        const own = new URL(req.url, 'http://x').searchParams.get('owner') || '';
        if (/^0x[0-9a-fA-F]{40}$/.test(own)) {
          // the piece as it draws for THAT holder; it never changes once drawn, so it caches for a day
          const f = await reader.stillFor(Number(m[1]), own);
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
          fs.createReadStream(f).pipe(res);
          return true;
        }
        const still = /[?&]still=1\b/.test(req.url);
        const file = await reader.artFile(Number(m[1]), still);
        if (!file) { json(res, 404, { error: 'no such token' }); return true; }
        // short cache: the art changes when the token changes hands
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' });
        fs.createReadStream(file).pipe(res);
      } else json(res, 404, { error: 'unknown route' });
    } catch (e) {
      console.log('api ' + rel + ' ⛔ ' + clean(e));
      json(res, 502, { error: 'chain read failed' });
    }
    return true;
  };
}

module.exports = { createReader, mount, clean };
