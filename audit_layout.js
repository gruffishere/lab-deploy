/* Layout audit for THE LAB, run in the page: `await import('/audit_layout.js'); __audit()`.
   The rule (SITE_SPEC): a layout change is not done until it is measured at 2400x1187, 1920x950, 1440x900 and
   1280x720. This measures, on the room that is open:
     - every element carrying its own words against every other one (no text may sit on text)
     - every visible element against the window (nothing may hang off it; scrolled content is judged by its scroller)
     - every colour block against the keep-out boxes (no block may rest on text, a button, the art or a panel)
     - how many blocks sit in the outer 22% band of the window (they belong on the rim)
   Blocks are first snapped to the homes the relay chose, so the answer does not depend on animation frames. */
window.__audit = function(){
  measureKeepOut();
  const limit = blockLimit();
  BLOCKS.forEach((b, i) => {
    if(i >= limit){ if(!b.gone) home(b, null); return; }
    if(b.gone || hitsKeep(b.hx, b.hy, b.sz)) home(b, freeSpot(b));
    b.x = b.hx; b.y = b.hy; b.free = false;
  });
  stepBlocks();
  const vis = BLOCKS.filter(b => !b.gone);
  const W = innerWidth, H = innerHeight;
  const shown = e => {
    if(e.closest('.hidden')) return false;
    const cs = getComputedStyle(e);
    if(cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const clipped = e => !!e.parentElement.closest('.invGrid,.pSide,.rowhand,#traitRows,header nav');
  const els = [...document.querySelectorAll('.room.on *, header *')].filter(e => shown(e) && !clipped(e) && !e.closest('.bigword'));
  const name = e => (e.id || (typeof e.className === 'string' && e.className) || e.tagName) + '';
  const outside = els.filter(e => { const r = e.getBoundingClientRect();
    // on a phone the page scrolls down by design, so only the sides count there
    // ACTIVITY is a feed that scrolls inside its room, so there too only the sides count
    return r.right > W+1 || r.left < -1 || (W >= 768 && !e.closest("#roomActivity, #roomDash") && (r.bottom > H+1 || r.top < -1)); }).map(name);
  const txt = els.filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
                 .filter(e => !e.closest('.bigword'));      // the giant wordmark is a backdrop that bleeds off the edge, by design
  const hits = [];
  for(let i = 0; i < txt.length; i++) for(let j = i+1; j < txt.length; j++){
    const a = txt[i], b = txt[j]; if(a.contains(b) || b.contains(a)) continue;
    const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    const ox = Math.min(r.right, s.right) - Math.max(r.left, s.left), oy = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
    if(ox > 2 && oy > 2) hits.push(name(a) + ' x ' + name(b));
  }
  const rim = vis.filter(b => { const cx = b.x+b.sz/2, cy = b.y+b.sz/2;
    return cx < W*.22 || cx > W*.78 || cy < 64+(H-64)*.22 || cy > H-(H-64)*.22; }).length;
  return { view, size: W+'x'+H, blocks: vis.length, blocksOnUI: vis.filter(b => hitsKeep(b.x, b.y, b.sz)).length,
           blocksAtRim: rim, outside: outside.slice(0, 8), textOverlaps: hits.slice(0, 8), textChecked: txt.length,
           pageWiderThanWindow: document.documentElement.scrollWidth > W };
};

/* REACHABLE: every link, button and input on the open room must actually receive the pointer at its centre.
   Added 2026-10-07 after DASHBOARD shipped with the whole room pointer-events:none: it looked perfect and nothing in
   it could be scrolled or clicked, and every measure above still said zero. Only on-screen elements are probed. */
window.__reach = function(){
  const W = innerWidth, H = innerHeight, dead = [];
  for(const el of document.querySelectorAll('.room.on a, .room.on button, .room.on input, header button')){
    if(el.disabled) continue;                      // SOON buttons are inert on purpose
    if(getComputedStyle(el).visibility === 'hidden') continue;   // hidden on purpose (an empty wallet hides the piece panel)
    const r = el.getBoundingClientRect();
    if(r.width < 2 || r.height < 2) continue;
    const x = r.left + r.width/2, y = r.top + r.height/2;
    if(x < 0 || y < 0 || x > W || y > H) continue;
    // a menu item scrolled out of the phone strip is reached by swiping, not judged here
    const strip = el.closest('header nav'); if(strip){ const n = strip.getBoundingClientRect(); if(x < n.left || x > n.right) continue; }
    const hit = document.elementFromPoint(x, y);
    if(!hit || !(hit === el || el.contains(hit))) dead.push((el.id || el.className || el.tagName) + ' <- ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing'));
  }
  return dead;
};
