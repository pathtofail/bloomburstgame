#!/usr/bin/env node
// Alt-6 (Bloom Jackpot) RTP simulator.
//
// Runs many feature spins, counts jackpot fills + total bloom RTP, then
// reports averages so we can derive payouts that hit any target RTP.
//
// Approach: extract the inline scripts from index.html, stub the PIXI /
// gsap / DOM globals, evaluate the engine, then call runSpin in a loop
// with alt-6 feature flags on.

import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync('index.html', 'utf8');

// Extract every script block.
const blocks = [...HTML.matchAll(/<script(?:\s+type=["']module["'])?[^>]*>([\s\S]*?)<\/script>/g)];
let code = blocks.map(b => b[1]).join('\n;\n');

// Strip top-level await PIXI.Assets.load(...) calls — replace with a
// fake texture object so accesses like `.width` / `.height` on the
// returned value don't crash.
code = code.replace(
  /await\s+PIXI\.Assets\.load\([^)]*\)/g,
  '({width:400,height:400,baseTexture:{width:400,height:400}})'
);

// The page's main script is itself an `(async function () { ... })();`
// IIFE. Inside our outer try/catch wrapper that fires unawaited, so
// any thrown error escapes as an unhandled rejection instead of being
// caught + reported. Prepend `await` so it propagates.
code = code.replace(
  /\(async function \(\) \{/,
  'await (async function () {'
);


// Wrap in an async IIFE; capture errors via `__setError` and resolve
// `__ready` via finally. Any unhandled rejection is also routed there
// via process listener below.
code = `
;(async () => {
  try {
    ${code}
  } catch (e) {
    __setError(e);
  } finally {
    __ready();
  }
})()
.catch(e => __setError(e));
`;

// ── Stubs ────────────────────────────────────────────────────────────────
const noop = () => {};
const chainable = new Proxy(() => chainable, { get: () => chainable });
const PIXIStub = {
  Assets: { load: async () => ({}) },
  Application: class {
    constructor() {
      this.screen = { width: 800, height: 600 };
      this.stage  = new ContainerStub();
      this.view   = { addEventListener: noop, removeEventListener: noop, style: {} };
      this.renderer = { resize: noop };
    }
  },
  // NOTE: these must be the actual stub classes (not wrappers that
  // `return new ContainerStub()`) — the engine's `class FlowerSymbol
  // extends PIXI.Container` needs the prototype chain intact, otherwise
  // subclass methods get clobbered when the constructor returns a
  // foreign object.
  Container: null,  // wired below after class declarations
  Sprite:    null,
  Graphics:  null,
  Text:      null,
  Point:     class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Rectangle: class {},
  RoundedRectangle: class {},
  Circle: class { constructor(x = 0, y = 0, r = 0) { this.x = x; this.y = y; this.radius = r; } },
  Ellipse: class {},
  Polygon: class {},
  Matrix: class {},
  Texture:   { from: () => ({}) },
};
class ContainerStub {
  constructor() {
    this.children = [];
    this.x = 0; this.y = 0;
    this.scale = { x: 1, y: 1, set: function (a, b) { this.x = a; this.y = b ?? a; } };
    this.position = { set: noop };
    this.alpha = 1;
    this.visible = true;
    this.eventMode = 'none';
    this.cursor = 'default';
    this.sortableChildren = false;
  }
  addChild(c) { this.children.push(c); return c; }
  addChildAt(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  removeChildren() { this.children.length = 0; }
  destroy() { this.destroyed = true; }
  on() { return this; }
  off() { return this; }
  toLocal(p) { return p; }
  toGlobal(p) { return p; }
  getGlobalPosition() { return { x: 0, y: 0 }; }
  getChildIndex() { return 0; }
}
class SpriteStub extends ContainerStub {
  constructor() {
    super();
    this.anchor = { set: noop };
    this.rotation = 0;
    this.skew = { x: 0, y: 0 };
    this.tint = 0xFFFFFF;
    this.texture = null;
  }
}
class GraphicsStub extends ContainerStub {
  beginFill() { return this; }
  endFill()   { return this; }
  lineStyle() { return this; }
  drawRect()  { return this; }
  drawRoundedRect() { return this; }
  drawCircle() { return this; }
  moveTo() { return this; }
  lineTo() { return this; }
  clear()  { return this; }
}
class TextStub extends ContainerStub {
  constructor(t) {
    super();
    this.text = t;
    this.anchor = { set: noop };
    this.style = {};
    this.width = 0;
    this.height = 0;
  }
}

PIXIStub.Container = ContainerStub;
PIXIStub.Sprite    = SpriteStub;
PIXIStub.Graphics  = GraphicsStub;
PIXIStub.Text      = TextStub;

const gsapStub = {
  to:         () => chainable,
  from:       () => chainable,
  fromTo:     () => chainable,
  set:        () => chainable,
  timeline:   () => ({ to: () => ({}), from: () => ({}), fromTo: () => ({}), call: () => ({}), kill: noop, eventCallback: noop }),
  killTweensOf: noop,
  delayedCall: () => ({ kill: noop }),
};

let _ready;
let _error = null;
const ready = new Promise(r => { _ready = r; });
const sandbox = {
  PIXI: PIXIStub,
  gsap: gsapStub,
  console,
  setTimeout, clearTimeout,
  setInterval, clearInterval,
  Math, Date, JSON, Promise, Set, Map,
  Array, Object, Number, String, Boolean, RegExp, Error,
  Proxy, Reflect, Symbol,
  Float32Array, Uint8Array, Int32Array, Uint16Array,
  parseInt, parseFloat, isNaN, isFinite,
  // Stubs for browser globals the script touches
  document: {
    addEventListener: noop, removeEventListener: noop,
    body: { appendChild: noop, style: {} },
    createElement: () => ({ style: {}, appendChild: noop, addEventListener: noop }),
    querySelector: () => null,
    getElementById: () => null,
    fonts: { load: async () => ({}) },
  },
  navigator: { userAgent: 'sim' },
  performance: { now: () => Date.now() },
  // Force the engine into alt-6 mode at boot — its `let ALT_MODE`
  // initializer reads localStorage with key 'bloom_burst_alt_mode'.
  localStorage: {
    getItem: (k) => (k === 'bloom_burst_alt_mode' ? 'alt6' : null),
    setItem: noop,
    removeItem: noop,
  },
  __ready: () => _ready(),
  __setError: (e) => { _error = e; },
  __probe: (label) => { console.log('  [probe]', label); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.requestAnimationFrame = noop;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.dispatchEvent = noop;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
sandbox.innerWidth = 1024;
sandbox.innerHeight = 768;
sandbox.devicePixelRatio = 1;

// Dump processed code to /tmp for inspection.
fs.writeFileSync('/tmp/sim-alt6-processed.js', code);

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'index.html' });
} catch (e) {
  console.error('vm.runInContext threw:', e && (e.stack || e.message || e));
  process.exit(1);
}

// Listen for unhandled rejections from the sandbox so we surface real errors.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && (reason.stack || reason.message || reason));
});

// Race the ready promise against a timeout so we don't hang forever.
const TIMEOUT = 5000;
await Promise.race([
  ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`engine init timed out after ${TIMEOUT}ms`)), TIMEOUT)),
]).catch(e => {
  console.error('Engine ready wait failed:', e.message);
  if (_error) console.error('Caught error in IIFE:', _error && (_error.stack || _error.message || _error));
  process.exit(1);
});

if (_error) {
  console.error('Engine init error:', _error && (_error.stack || _error.message || _error));
  process.exit(1);
}

if (_error) {
  console.error('Engine load error:', _error && (_error.stack || _error.message || _error));
  process.exit(1);
}

// ── Sim ──────────────────────────────────────────────────────────────────
const BloomSort = sandbox.window.BloomSort || sandbox.BloomSort;
if (!BloomSort) {
  console.error('BloomSort not exposed on window — engine likely failed to load');
  console.error('window keys (first 20):', Object.keys(sandbox.window).slice(0, 20));
  console.error('Has BloomSort?', 'BloomSort' in sandbox);
  process.exit(1);
}

const { runSpin, setRng, makeSeededRng } = BloomSort;

// Force alt-6 mode for the sim.
sandbox.ALT_MODE = 'alt6';

function simAlt6Feature({ features = 10000, spinsPerFeature = 15, bet = 1, seed = 12345 } = {}) {
  setRng(makeSeededRng(seed));
  const fills = { tiny: 0, mini: 0, major: 0, grand: 0 };
  let totalBloomPay = 0;
  let totalFeatureWin = 0;
  let totalScatterPay = 0;
  let totalJackpotPay = 0;
  // Ripple petal color tally — counts every petal emitted by feature
  // ripples so we can verify the actual color distribution matches
  // ALT6_FEATURE_RIPPLE_WEIGHTS expectations.
  const ripplePetalCounts = {
    Sky: 0, Pearl: 0, Teal: 0, Lime: 0,
    Magenta: 0, Gold: 0, Scarlet: 0, Indigo: 0,
  };
  let ripplePetalTotal = 0;
  // Per-feature totals (each entry = one 15-spin feature buy's return / bet)
  const featureReturns = new Float64Array(features);
  const spins = features * spinsPerFeature;
  for (let f = 0; f < features; f++) {
    // Pots reset at the start of every feature buy. AND-fill model:
    // each tier has per-color counts; tier fills when ALL color counts
    // reach potCapacity (8).
    let alt6Jackpots = [
      { tier: 'tiny',  counts: { Sky: 0, Pearl: 0 } },
      { tier: 'mini',  counts: { Teal: 0, Lime: 0 } },
      { tier: 'major', counts: { Magenta: 0, Gold: 0 } },
      { tier: 'grand', counts: { Scarlet: 0, Indigo: 0 } },
    ];
    let featureReturn = 0;
    for (let s = 0; s < spinsPerFeature; s++) {
      const r = runSpin(bet, {
        alt6FeatureActive: true,
        alt6Jackpots,
        freeSpin: true,
      });
      totalBloomPay   += r.totalPayout;
      totalFeatureWin += r.finalWin;
      totalScatterPay += r.scatterPay || 0;
      featureReturn   += r.finalWin || 0;
      // Tally ripple petal colors from each cascade event.
      if (r.events) {
        for (const ev of r.events) {
          if (ev && ev.ripplePetals && ev.ripplePetals.length) {
            for (const p of ev.ripplePetals) {
              if (ripplePetalCounts[p.color] != null) {
                ripplePetalCounts[p.color] += 1;
                ripplePetalTotal += 1;
              }
            }
          }
        }
      }
      if (r.alt6Jackpots) alt6Jackpots = r.alt6Jackpots;
      if (r.alt6JackpotPays) {
        for (const p of r.alt6JackpotPays) {
          if (fills[p.tier] != null) fills[p.tier] += 1;
          const pay = (p.payout || 0) * bet;
          totalJackpotPay += pay;
          featureReturn   += pay;
        }
      }
    }
    featureReturns[f] = featureReturn / bet;
  }
  // Stats on per-feature return (in units of bet).
  let mean = 0;
  for (let i = 0; i < features; i++) mean += featureReturns[i];
  mean /= features;
  let m2 = 0;
  let max = -Infinity, min = Infinity;
  for (let i = 0; i < features; i++) {
    const d = featureReturns[i] - mean;
    m2 += d * d;
    if (featureReturns[i] > max) max = featureReturns[i];
    if (featureReturns[i] < min) min = featureReturns[i];
  }
  const variance = m2 / features;
  const stddev   = Math.sqrt(variance);
  // Hit frequencies vs the 100× bet buy cost.
  let nWin = 0, nProfit = 0, nBigWin = 0, nMega = 0;
  for (let i = 0; i < features; i++) {
    if (featureReturns[i] > 0)        nWin++;
    if (featureReturns[i] >= 100)     nProfit++;
    if (featureReturns[i] >= 200)     nBigWin++;
    if (featureReturns[i] >= 1000)    nMega++;
  }
  // Percentiles.
  const sorted = Array.from(featureReturns).sort((a,b) => a-b);
  const pct = (p) => sorted[Math.min(features - 1, Math.floor(p * features))];
  return {
    spins, features,
    fills,
    fillsPerSpin: {
      tiny:  fills.tiny  / spins,
      mini:  fills.mini  / spins,
      major: fills.major / spins,
      grand: fills.grand / spins,
    },
    fillsPer15: {
      tiny:  fills.tiny  / features,
      mini:  fills.mini  / features,
      major: fills.major / features,
      grand: fills.grand / features,
    },
    bloomRtpPerSpin:    totalBloomPay   / (spins * bet),
    finalWinRtpPerSpin: totalFeatureWin / (spins * bet),
    scatterRtpPerSpin:  totalScatterPay / (spins * bet),
    jackpotRtpPerSpin:  totalJackpotPay / (spins * bet),
    ripplePetalCounts,
    ripplePetalTotal,
    perFeature: {
      mean, stddev, variance, min, max,
      // Volatility index: stddev / cost. Industry uses stddev of return
      // per unit wagered. For a 100× bet feature buy, σ/100 is the
      // per-unit-wagered volatility.
      volIndex: stddev / 100,
      hitRateWin:    nWin    / features,
      hitRateProfit: nProfit / features,
      hitRateBigWin: nBigWin / features,
      hitRateMega:   nMega   / features,
      p01: pct(0.01), p05: pct(0.05), p25: pct(0.25),
      p50: pct(0.50), p75: pct(0.75), p95: pct(0.95),
      p99: pct(0.99), p999: pct(0.999),
    },
  };
}

// CLI arg = number of FEATURES to sim (each = 15 spins). Pots reset
// between features so per-feature variance/volatility numbers are valid.
const F = parseInt(process.argv[2] || '20000', 10);
console.log(`\nSimulating ${F} alt-6 feature buys (× 15 spins each)...\n`);
const t0 = Date.now();
const r = simAlt6Feature({ features: F, bet: 1, seed: 42 });
const dt = Date.now() - t0;
console.log(`Done in ${dt}ms (${r.spins} total spins).\n`);

const N = r.spins;
console.log(`── Jackpot fills (cumulative across ${N} spins) ──`);
console.log(`  Tiny  : ${r.fills.tiny}`);
console.log(`  Mini  : ${r.fills.mini}`);
console.log(`  Major : ${r.fills.major}`);
console.log(`  Grand : ${r.fills.grand}`);

console.log(`\n── Hit rate per spin ──`);
console.log(`  Tiny  : ${r.fillsPerSpin.tiny.toFixed(5)}  (1 in ${(1/r.fillsPerSpin.tiny).toFixed(1)})`);
console.log(`  Mini  : ${r.fillsPerSpin.mini.toFixed(5)}  (1 in ${(1/r.fillsPerSpin.mini).toFixed(1)})`);
console.log(`  Major : ${r.fillsPerSpin.major.toFixed(5)}  (1 in ${(1/r.fillsPerSpin.major).toFixed(1)})`);
console.log(`  Grand : ${r.fillsPerSpin.grand.toFixed(5)}  (1 in ${(1/r.fillsPerSpin.grand).toFixed(1)})`);

console.log(`\n── Hit rate per 15-spin feature ──`);
console.log(`  Tiny  : ${r.fillsPer15.tiny.toFixed(3)}`);
console.log(`  Mini  : ${r.fillsPer15.mini.toFixed(3)}`);
console.log(`  Major : ${r.fillsPer15.major.toFixed(3)}`);
console.log(`  Grand : ${r.fillsPer15.grand.toFixed(3)}`);

console.log(`\n── RTP from regular blooms (× bet, per spin) ──`);
console.log(`  Bloom payout (pre-finalmult): ${r.bloomRtpPerSpin.toFixed(3)}× bet`);
console.log(`  Final win   (post-finalmult): ${r.finalWinRtpPerSpin.toFixed(3)}× bet`);
console.log(`  Scatter pay                 : ${r.scatterRtpPerSpin.toFixed(3)}× bet`);

console.log(`  Jackpot pay                 : ${r.jackpotRtpPerSpin.toFixed(3)}× bet`);

console.log(`\n── Per-15-spin feature totals ──`);
const featureBloom   = r.finalWinRtpPerSpin * 15;
const featureJackpot = r.jackpotRtpPerSpin  * 15;
const featureTotal   = featureBloom + featureJackpot;
console.log(`  Bloom + scatter × 15 spins   : ${featureBloom.toFixed(2)}× bet`);
console.log(`  Jackpot pay     × 15 spins   : ${featureJackpot.toFixed(2)}× bet`);
console.log(`  Total per feature            : ${featureTotal.toFixed(2)}× bet`);
console.log(`  Buy cost (100× bet)          : 100.00× bet`);
console.log(`  Feature RTP                  : ${(featureTotal).toFixed(2)}%`);

const pf = r.perFeature;
console.log(`\n── Per-feature return stats (return ÷ bet, ${r.features} features) ──`);
console.log(`  Mean              : ${pf.mean.toFixed(2)}× bet  (target ~96.4)`);
console.log(`  Std deviation     : ${pf.stddev.toFixed(2)}× bet`);
console.log(`  Variance          : ${pf.variance.toFixed(0)}`);
console.log(`  Volatility index  : ${pf.volIndex.toFixed(3)}  (σ ÷ buy cost)`);
console.log(`  Min / Max         : ${pf.min.toFixed(2)} / ${pf.max.toFixed(2)}× bet`);

console.log(`\n── Per-feature win distribution ──`);
console.log(`  P(any win > 0)         : ${(pf.hitRateWin    * 100).toFixed(2)}%`);
console.log(`  P(profit, ≥ 100× bet)  : ${(pf.hitRateProfit * 100).toFixed(2)}%  (recoup the buy)`);
console.log(`  P(big win, ≥ 200× bet) : ${(pf.hitRateBigWin * 100).toFixed(2)}%`);
console.log(`  P(mega,    ≥1000× bet) : ${(pf.hitRateMega   * 100).toFixed(2)}%`);

console.log(`\n── Ripple petal color distribution (${r.ripplePetalTotal} petals) ──`);
const TIERS = [
  ['Sky',    'Pearl',   'Tiny'],
  ['Teal',   'Lime',    'Mini'],
  ['Magenta','Gold',    'Major'],
  ['Scarlet','Indigo',  'Grand'],
];
for (const [c1, c2, t] of TIERS) {
  const n1 = r.ripplePetalCounts[c1];
  const n2 = r.ripplePetalCounts[c2];
  const p1 = (n1 / r.ripplePetalTotal * 100).toFixed(2);
  const p2 = (n2 / r.ripplePetalTotal * 100).toFixed(2);
  const tot = ((n1 + n2) / r.ripplePetalTotal * 100).toFixed(2);
  console.log(`  ${t.padEnd(6)} ${c1.padEnd(8)}: ${p1.padStart(6)}%   ${c2.padEnd(8)}: ${p2.padStart(6)}%   (combined ${tot}%)`);
}

console.log(`\n── Per-feature percentiles (return × bet) ──`);
console.log(`   1% : ${pf.p01.toFixed(2).padStart(7)}    25% : ${pf.p25.toFixed(2).padStart(7)}    75% : ${pf.p75.toFixed(2).padStart(7)}    99% : ${pf.p99.toFixed(2).padStart(7)}`);
console.log(`   5% : ${pf.p05.toFixed(2).padStart(7)}    50% : ${pf.p50.toFixed(2).padStart(7)}    95% : ${pf.p95.toFixed(2).padStart(7)}   99.9%: ${pf.p999.toFixed(2).padStart(7)}`);
