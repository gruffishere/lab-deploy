/* One call runs the whole layout + reach audit on every room the current state can open, and catches errors.
   In the page: `await import('/audit_run.js?'+Date.now()); await __runAll()`. Used before launch, 2026-10-07. */
window.__errs = window.__errs || [];
if(!window.__errHooked){ window.__errHooked = true;
  window.addEventListener('error', e => window.__errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__errs.push('promise: ' + String(e.reason && e.reason.message || e.reason))); }
window.__runAll = async function(){
  await import('/audit_layout.js?' + Date.now());
  const rooms = ['home','dash','turn','forge','activity'].concat(connected ? ['profile'] : []);
  const out = {}, bad = [];
  for(const v of rooms){
    go(v);
    await new Promise(r => setTimeout(r, (v === 'dash' || v === 'activity') ? 3500 : 1000));
    window.scrollTo(0, 0);
    const a = __audit(), dead = __reach();
    out[v] = [a.blocksOnUI, a.outside.length, a.textOverlaps.length, a.pageWiderThanWindow ? 1 : 0, dead.length];
    if(a.blocksOnUI || a.outside.length || a.textOverlaps.length || a.pageWiderThanWindow || dead.length)
      bad.push(v + ': ' + JSON.stringify({ out: a.outside.slice(0,3), ov: a.textOverlaps.slice(0,3), dead: dead.slice(0,3) }));
  }
  return { size: innerWidth + 'x' + innerHeight, connected, rooms: out, bad, errors: window.__errs.slice(0, 5) };
};
