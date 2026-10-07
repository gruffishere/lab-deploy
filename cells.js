/* A chain svg → a flat 35x35 array of colours, so a single block can be ringed, lifted and moved.
   ⛔ A PORT OF exp/onchain/_svgcells.cjs, not a fresh parser. Every ad-hoc FACETS parser so far returned a clean,
   plausible, wrong picture. The three traps it handles: background cells are never emitted (one full-bleed rect
   covers them), <g fill> groups whose rects carry no fill, and row runs; plus the <path> emission of 2026-09-24.
   It throws on path data it does not understand and on any cell left unresolved, instead of drawing less.
   Proof that it equals the original on every token: node exp/site_draft/verify_cells.cjs            */
(function(root){
  const N = 35;
  function cells(svg){
    const a = new Array(N * N).fill(null);
    const bg = svg.match(/<rect width="\d+" height="\d+" fill="([^"]+)"\/>/);
    if(bg) a.fill(bg[1]);
    const put = (x, y, wd, ht, col) => {
      for(let dy = 0; dy < (ht || 1); dy++) for(let dx = 0; dx < (wd || 1); dx++){
        const c = x + dx, r = y + dy; if(c >= 0 && c < N && r >= 0 && r < N) a[r * N + c] = col;
      }
    };
    const rectsIn = (body, col) => {
      for(const m of body.matchAll(/<rect x="(-?\d+)" y="(-?\d+)"(?: width="(\d+)")?(?: height="(\d+)")?(?: fill="([^"]+)")?/g))
        put(+m[1], +m[2], m[3] ? +m[3] : 1, m[4] ? +m[4] : 1, m[5] || col);
    };
    const EL = /<g fill="([^"]+)"[^>]*>([\s\S]*?)<\/g>|<path fill="([^"]+)" d="([^"]*)"\/>|<rect x="(-?\d+)" y="(-?\d+)"(?: width="(\d+)")?(?: height="(\d+)")? fill="([^"]+)"/g;
    for(const m of svg.matchAll(EL)){
      if(m[1] !== undefined) rectsIn(m[2], m[1]);
      else if(m[3] !== undefined){
        for(const s of m[4].matchAll(/M(-?\d+) (-?\d+)h(\d+)v(\d+)H-?\d+z/g)) put(+s[1], +s[2], +s[3], +s[4], m[3]);
        if(m[4].replace(/M-?\d+ -?\d+h\d+v\d+H-?\d+z/g, '') !== '') throw new Error('cells: unrecognised path data');
      }
      else put(+m[5], +m[6], m[7] ? +m[7] : 1, m[8] ? +m[8] : 1, m[9]);
    }
    const miss = a.filter(c => c === null).length;
    if(miss) throw new Error('cells: ' + miss + ' of 1225 unresolved');
    return a;
  }
  if(typeof module !== 'undefined' && module.exports) module.exports = { cells, N };
  else root.FacetsCells = { cells, N };
})(this);
