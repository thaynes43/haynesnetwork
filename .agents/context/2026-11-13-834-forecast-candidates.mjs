// Story 834, DESIGN-013 D-08: the candidate comparison behind the Capacity Forecast method.
// Run: node .agents/context/2026-11-13-834-forecast-candidates.mjs
// No dependency, no network, no clock read; the random draws are seeded, so every run prints the same numbers.
// The tables in 2026-11-13-834-storage-forecast.md and in D-08 are this script's output of 2026-11-13.
const DAY = 86400;

// --- Data -----------------------------------------------------------------------------------------
// (1) The recorded series: measured by the coordinator 2026-11-13T16:36Z. Prometheus, 90 days, 3-day step, GB = 1e9
// bytes, query max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"}).
// Columns: UTC day, HaynesTower free, music array free.
const REC = [
  ['2026-08-14', 97170.9, 121411.8], ['2026-08-17', 96487.7, 121316.9], ['2026-08-20', 95534.6, 121288.8],
  ['2026-08-23', 95096, 120984], ['2026-08-26', 93523.7, 120706], ['2026-08-29', 92515.1, 120531.5],
  ['2026-09-01', 92716.6, 120263.5], ['2026-09-04', 90963.6, 120214.5], ['2026-09-07', 90446.7, 120136.6],
  ['2026-09-10', 90004.6, 120108.2], ['2026-09-13', 89442.3, 120075.1], ['2026-09-16', 89604.7, 120021.9],
  ['2026-09-19', 88983, 119927.9], ['2026-09-22', 88636.5, 119847.6], ['2026-09-25', 87970, 119867.4],
  ['2026-09-28', 86825.7, 119610.1], ['2026-10-01', 86498.4, 120568.4], ['2026-10-04', 85466.7, 120649.6],
  ['2026-10-07', 85654.4, 120468.8], ['2026-10-10', 84428.1, 120245.1], ['2026-10-13', 84711, 120062.4],
  ['2026-10-16', 83941.8, 120000.7], ['2026-10-19', 82920.9, 119760.3], ['2026-10-22', 82047.5, 119717.5],
  ['2026-10-25', 80932.5, 119434.7], ['2026-10-28', 80198.3, 120654.5], ['2026-10-31', 80066.7, 113795],
  ['2026-11-03', 78500.2, 109951.2], ['2026-11-06', 78277, 108767.8], ['2026-11-09', 80138.3, 108727.7],
  ['2026-11-12', 88140.8, 110378.8],
];
const series = (col) => REC.map((r) => ({ t: Date.parse(r[0] + 'T00:00:00Z') / 1000, y: r[col] }));
// (2) The same two arrays at a 12-hour step: measured by this session 2026-11-13 through the Grafana MCP server
// (query_prometheus, datasource `prometheus`, range 2026-08-05T00:00Z..2026-11-13T12:00Z, step 43200 s):
//   round(max by (path) (radarr_rootfolder_freespace_bytes) / 1e9, 0.1)
//   round(max by (path) (lidarr_rootfolder_freespace_bytes) / 1e9, 0.1)
// The oldest sample Prometheus returned is 2026-08-07T12:00Z (unix 1786104000), 98 days before the query.
const H12_T0 = 1786104000;
const HT12 = [101228,100950.1,100768.8,101146,100757.3,100368.9,100028,99910.6,99671.5,99020.4,98428.6,98046.6,97491.7,97170.9,96710.4,96606.8,96091.1,96896.9,96731.7,96487.7,96449.2,96165.8,96106.5,95845.9,95686.7,95534.6,95352.9,95123.4,94957.7,94804.1,94504.8,95096,94891.1,94783.5,94653.3,94061.6,93578.4,93523.7,93433.4,93313.6,93336.2,93247.6,92987.3,92515.1,92300.8,93505,93349.6,93300.1,92801.3,92716.6,92484.1,91927.6,91812.2,91510.5,91039.2,90963.6,90797.6,90602.1,90523.2,89616.9,90442,90446.7,90305.3,90279.2,90084.2,90016.6,89801.8,90004.6,89881.1,89852.8,89756.5,89682.4,89514.5,89442.3,89980.9,89916.1,89766.7,89835,89632.9,89604.7,89511,89440.8,89306,89199.2,89120.3,88983,88861.3,88067.6,88832.9,88751.8,88683.2,88636.5,88369.2,88269.1,88150.6,88087.5,88024.3,87970,87819.7,87776.7,87723.7,87123.3,87053.9,86825.7,88034.4,87404.9,86710.1,86685.4,86544.9,86498.4,86073.7,85691.8,85396.6,85254.8,85505.7,85466.7,85235.3,85096.5,85792.3,85689.8,85739.1,85654.4,85361.3,84895.1,84823.3,84737.4,84577.9,84428.1,84328.3,84252.8,84017.4,83923,84846.5,84711,84533.6,84438.7,84236.8,84167.6,84039.9,83941.8,83868.7,83664.2,83509.3,83233,83128.2,82920.9,82769.7,82395.3,82312.7,82193.7,82132.6,82047.5,81838.1,81706.9,81552.3,81328,81146.8,80932.5,80743.9,80560.6,80445,80386.7,80265.7,80198.3,80043.6,79920.5,79797.4,80225.7,80049.4,80066.7,79940.9,79706.7,79486.6,78741.9,78613.9,78500.2,78146.5,78071.9,78023.7,77944.9,77569.6,78277,78143.2,81248.2,80938.6,80666.3,80431.1,80138.3,80008.1,79876.6,79775.3,79542.3,79416.3,88140.8,87901.8,87845.8,87603.3];
const MU12 = [121661.6,121586.3,121574.6,121552.1,121533.6,121518.4,121496.1,121467.1,121473,121446.6,121438.6,121425.4,121402.8,121411.8,121394.1,121383.2,121369.5,121353.2,121332.7,121316.9,121314.5,121313.6,121311,121300.8,121278.5,121288.8,121265.6,121223.2,121219.8,121115.6,121021.5,120984,120977,120897.4,120812.6,120755.1,120726.1,120706,120670.9,120656.3,120630.6,120589.2,120586.9,120531.5,120362.9,120302.2,120291.4,120292.7,120278.7,120263.5,120251.7,120260.1,120256.4,120261.3,120230.8,120214.5,120196.7,120185,120192.2,120184.8,120151.5,120136.6,120134.2,120129,120110.1,120098.1,120125.6,120108.2,120114.8,120093.5,120124.6,120121,120119.8,120075.1,120049.5,120029.7,120025,120037,120019.8,120021.9,119989.4,119949.3,119966.1,119938.3,119912.1,119927.9,119909.8,119889.8,119877.2,119848.8,119856,119847.6,120046.1,120009.8,120005.5,119997.3,119992,119867.4,119785.6,119774.2,119727.6,119680.9,119643.4,119610.1,119599.3,119587.4,119616.9,120430.6,120505.8,120568.4,120663.1,120701.8,120750.5,120738.1,120689.1,120649.6,120631.3,120608.5,120531.2,120524.5,120474.7,120468.8,120430.6,120432,120288.9,120294.3,120278,120245.1,120255.6,120191.6,120136.4,120114.6,120095.5,120062.4,120120.4,120063.5,120062.9,120063.5,120038.1,120000.7,119988.2,119961.2,119957.7,119886.7,119883.5,119760.3,119758.9,119747.9,119760.4,119742.8,119726,119717.5,119734.3,119694.7,119732.6,119665.6,119656.5,119434.7,119413.6,119160.9,118820.3,118636.3,118474.8,120654.5,118446.9,118109.4,118038.9,116358.4,114358.7,113795,112372.1,111330.9,110959.7,110699.6,110380.8,109951.2,109715.3,109228.2,109044.2,108937.6,108903.9,108767.8,108894.9,108859.1,108826.6,108814.4,108773.4,108727.7,108726.8,108044.8,105716.1,113760.2,112241,110378.8,109410.1,108080.8,106193.8];
const pts12 = (a) => a.map((y, i) => ({ t: H12_T0 + i * 43200, y }));

// --- Candidates: each takes ascending points [{t unix s, y GB}] and returns GB/day -------------------
const sum = (a) => a.reduce((u, v) => u + v, 0);
const mean = (a) => sum(a) / a.length;
const median = (a) => { const s = [...a].sort((u, v) => u - v); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function ols(p) {
  const x = p.map((q) => q.t / DAY), y = p.map((q) => q.y), n = p.length, mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const slope = sxy / sxx, icpt = my - slope * mx; let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - icpt - slope * x[i]) ** 2;
  return { slope, icpt, sigma: Math.sqrt(sse / (n - 2)) };
}
/** B, the method at 93434821: least squares, unless the newest sample is over 4 sigma off the line through samples at least 6 days older. */
function olsHold(p) {
  const last = p[p.length - 1], prefix = p.filter((q) => q.t <= last.t - 6 * DAY);
  if (prefix.length >= 8 && prefix[prefix.length - 1].t - prefix[0].t >= 21 * DAY) {
    const e = ols(prefix), resid = last.y - (e.icpt + e.slope * (last.t / DAY));
    if (e.sigma === 0 ? resid !== 0 : Math.abs(resid) > 4 * e.sigma) return { slope: e.slope, hold: true };
  }
  return { slope: ols(p).slope, hold: false };
}
function theilSen(p) { const s = []; for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) s.push((p[j].y - p[i].y) / ((p[j].t - p[i].t) / DAY)); return median(s); }
/** A step: the change per day between two consecutive samples. */
const steps = (p) => p.slice(1).map((q, i) => (q.y - p[i].y) / ((q.t - p[i].t) / DAY));
/** Mean of the steps left after setting aside floor(n * share) at each end of the sorted list. */
const trim = (share) => (p) => { const s = steps(p).sort((u, v) => u - v), g = Math.floor(s.length * share); return mean(s.slice(g, s.length - g)); };
/** Standard error of the 25% trimmed mean (Tukey and McLaughlin): Winsorized sum of squares / (h (h - 1)). */
function trimSe(p) {
  const s = steps(p).sort((u, v) => u - v), n = s.length, g = Math.floor(n / 4), h = n - 2 * g;
  const w = s.map((v, i) => (i < g ? s[g] : i >= n - g ? s[n - g - 1] : v)), m = mean(w);
  return Math.sqrt(sum(w.map((v) => (v - m) ** 2)) / (h * (h - 1)));
}
/** Scaled distance of each step from the median step: |d - median| / (1.4826 * MAD). */
function scaled(d) { const m = median(d), madn = 1.4826 * median(d.map((v) => Math.abs(v - m))); return d.map((v) => (v - m) / madn); }
function flaggedMean(p) { const d = steps(p), z = scaled(d); return mean(d.filter((_, i) => !(Math.abs(z[i]) > 3))); }
function flaggedOls(p) {
  const d = steps(p), z = scaled(d), m = median(d); let shift = 0; const out = [{ ...p[0] }];
  for (let i = 1; i < p.length; i++) { if (Math.abs(z[i - 1]) > 3) shift += (d[i - 1] - m) * ((p[i].t - p[i - 1].t) / DAY); out.push({ t: p[i].t, y: p[i].y - shift }); }
  return ols(out).slope;
}
const CANDS = {
  'A least squares, 90 d': (p) => ols(p).slope,
  'B A + newest-sample hold (PR)': (p) => olsHold(p).slope,
  'C Theil-Sen on levels': theilSen,
  'D median step': (p) => median(steps(p)),
  'E trimmed mean of steps, 10%': trim(0.1),
  'E trimmed mean of steps, 20%': trim(0.2),
  'E trimmed mean of steps, 25%': trim(0.25),
  'E trimmed mean of steps, 33%': trim(1 / 3),
  'F mean of unflagged steps': flaggedMean,
  'G least squares, flagged steps removed': flaggedOls,
};
const CHOSEN = CANDS['E trimmed mean of steps, 25%'];

// --- Helpers ----------------------------------------------------------------------------------------
const f1 = (v) => v.toFixed(1);
const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const isoSec = (t) => new Date(Math.round(t) * 1000).toISOString().replace('.000Z', 'Z');
const fullAt = (p, rate) => p[p.length - 1].t + (p[p.length - 1].y / -rate) * DAY;
const fullDay = (p, rate) => (rate < 0 ? isoDay(fullAt(p, rate)) : 'none');
const pad = (s, n) => String(s).padStart(n);
const head = (s) => console.log('\n== ' + s + ' ==');
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const ht = series(1), mu = series(2);

head('1. Recorded series, as of 2026-11-12: rate (GB/day) and the day free space reaches 0');
for (const [name, fn] of Object.entries(CANDS)) console.log(name.padEnd(40), 'HaynesTower', pad(f1(fn(ht)), 7), fullDay(ht, fn(ht)), ' music', pad(f1(fn(mu)), 7), fullDay(mu, fn(mu)));

head('2. HaynesTower continued from the 2026-11-12 level at its pre-jump rate, read 90 days back at each later sample');
const pre = ols(ht.slice(0, 29));
const TRUE = pre.slope;
console.log('pre-jump rate (least squares through 2026-11-06, 29 samples):', TRUE, 'GB/day; residual sigma', pre.sigma.toFixed(2), 'GB');
console.log('true 100% instant:', isoSec(fullAt(ht, TRUE)));
function continued(k) {
  const out = [...ht], last = ht[ht.length - 1];
  for (let i = 1; i <= k; i++) out.push({ t: last.t + i * 3 * DAY, y: last.y + TRUE * 3 * i });
  const end = out[out.length - 1].t; return out.filter((q) => q.t >= end - 90 * DAY);
}
const ROWS = [0, 3, 6, 9, 18, 30, 42, 66, 90];
console.log('days after 2026-11-12'.padEnd(40), ROWS.map((d) => pad(d, 7)).join(''), '  lowest  highest  worst error (0..180 d)');
for (const [name, fn] of Object.entries(CANDS)) {
  let worst = 0, lo = Infinity, hi = -Infinity;
  for (let k = 0; k <= 60; k++) { const r = fn(continued(k)); worst = Math.max(worst, Math.abs(r - TRUE)); lo = Math.min(lo, r); hi = Math.max(hi, r); }
  console.log(name.padEnd(40), ROWS.map((d) => pad(f1(fn(continued(d / 3))), 7)).join(''), pad(f1(lo), 8), pad(f1(hi), 8), pad(f1(worst), 7), pad((100 * worst / -TRUE).toFixed(1) + '%', 6));
}
console.log('B hold applied:'.padEnd(40), ROWS.map((d) => pad(olsHold(continued(d / 3)).hold ? 'yes' : 'no', 7)).join(''));
console.log('B 100% day:'.padEnd(40), ROWS.map((d) => { const p = continued(d / 3); return fullDay(p, olsHold(p).slope); }).join(' '));
console.log('chosen 100% day:'.padEnd(40), ROWS.map((d) => { const p = continued(d / 3); return fullDay(p, CHOSEN(p)); }).join(' '));
{ let lo = Infinity, hi = -Infinity, loK = 0, hiK = 0; for (let k = 0; k <= 60; k++) { const p = continued(k), at = fullAt(p, CHOSEN(p)); if (at < lo) { lo = at; loK = k; } if (at > hi) { hi = at; hiK = k; } }
  console.log('chosen 100% day, earliest and latest over 0..180 d:', isoDay(lo), '(day ' + loK * 3 + ')', isoDay(hi), '(day ' + hiK * 3 + ')'); }

head('3. The steps (GB per 3 days) and their scaled distance from the median step');
for (const [name, p] of [['HaynesTower', ht], ['music', mu]]) {
  const d = steps(p).map((v) => v * 3), z = scaled(d);
  console.log(name, 'steps:', d.map(f1).join(' '));
  console.log(name, 'median', f1(median(d)), ' 1.4826*MAD', f1(1.4826 * median(d.map((v) => Math.abs(v - median(d))))), ' scaled distance, sorted:', z.map(Math.abs).sort((a, b) => a - b).map((v) => v.toFixed(2)).join(' '));
  console.log(name, 'steps beyond 3: low side', z.filter((v) => v < -3).length, ', high side', z.filter((v) => v > 3).length, 'of', d.length, '; negative steps', d.filter((v) => v < 0).length);
}
const acf1 = (d) => { const m = mean(d); let num = 0, den = 0; for (let i = 0; i < d.length; i++) { den += (d[i] - m) ** 2; if (i) num += (d[i] - m) * (d[i - 1] - m); } return num / den; };
const hp = steps(ht).slice(0, 28);
console.log('HaynesTower, the 28 steps before the rise: mean', f1(mean(hp)), 'GB/day, median', f1(median(hp)), ', lag-1 autocorrelation', acf1(hp).toFixed(2));

head('4. The 12-hour series');
const h12 = pts12(HT12), m12 = pts12(MU12);
console.log('HaynesTower 12-hour rises over 400 GB:'); for (let i = 1; i < h12.length; i++) { const d = h12[i].y - h12[i - 1].y; if (d > 400) console.log('  ', new Date(h12[i].t * 1000).toISOString().slice(0, 16) + 'Z', '+' + f1(d)); }
console.log('music 12-hour changes over 500 GB either way:'); for (let i = 1; i < m12.length; i++) { const d = m12[i].y - m12[i - 1].y; if (Math.abs(d) > 500) console.log('  ', new Date(m12[i].t * 1000).toISOString().slice(0, 16) + 'Z', (d > 0 ? '+' : '') + f1(d)); }
const at12 = (p, iso) => p.find((q) => q.t === Date.parse(iso) / 1000).y;
console.log('music 2026-08-14T00Z..2026-10-25T00Z:', f1((at12(m12, '2026-10-25T00:00:00Z') - at12(m12, '2026-08-14T00:00:00Z')) / 72), 'GB/day; 2026-10-25T00Z..2026-11-13T12Z:', f1((at12(m12, '2026-11-13T12:00:00Z') - at12(m12, '2026-10-25T00:00:00Z')) / 19.5), 'GB/day');
console.log('level change 2026-11-12T00Z..2026-11-13T12Z: HaynesTower', f1(at12(h12, '2026-11-13T12:00:00Z') - at12(h12, '2026-11-12T00:00:00Z')), 'GB, music', f1(at12(m12, '2026-11-13T12:00:00Z') - at12(m12, '2026-11-12T00:00:00Z')), 'GB');

// --- Weekly block bootstrap of the 12-hour HaynesTower steps before the two large rises --------------
// 2026-08-07T12:00Z..2026-10-30T12:00Z is 168 steps = 12 whole weeks. A replicate draws 13 of those weeks with
// replacement (91 days) and is read at the wanted step. Its true rate is known: the mean of the 168 steps.
const d12 = HT12.slice(1, 169).map((y, i) => y - HT12[i]);
const blocks = []; for (let b = 0; b < 12; b++) blocks.push(d12.slice(b * 14, b * 14 + 14));
const POP = sum(d12) / 84;
const levels = (rnd) => { const lv = [100000]; for (let w = 0; w < 13; w++) for (const s of blocks[Math.floor(rnd() * 12)]) lv.push(lv[lv.length - 1] + s); return lv; };
const read = (lv, n, every = 6) => { const p = []; for (let i = 0; i <= n; i++) p.push({ t: i * every * 43200, y: lv[i * every] }); return p; };
const rise = (p, k) => p.map((q, i) => ({ t: q.t, y: q.y + (i >= k ? 1861.3 : 0) + (i >= k + 1 ? 8002.5 : 0) }));
const fall = (p, k) => p.map((q, i) => ({ t: q.t, y: q.y - (i >= k ? 6859.5 : 0) - (i >= k + 1 ? 3843.8 : 0) - (i >= k + 2 ? 1183.4 : 0) }));
const N = 4000;

head('5. Sampling noise: root-mean-square error against the true rate ' + f1(POP) + ' GB/day, ' + N + ' replicates, 30 steps of 3 days');
const SCEN = {
  'no jump': (p) => p,
  'the HaynesTower rise (+1861.3, +8002.5), anywhere': (p, rnd) => rise(p, 1 + Math.floor(rnd() * 29)),
  'the music fall (-6859.5, -3843.8, -1183.4), anywhere': (p, rnd) => fall(p, 1 + Math.floor(rnd() * 28)),
  'both': (p, rnd) => fall(rise(p, 1 + Math.floor(rnd() * 29)), 1 + Math.floor(rnd() * 28)),
};
const BOOT = { 'plain mean (last - first) / days': (p) => (p[p.length - 1].y - p[0].y) / ((p[p.length - 1].t - p[0].t) / DAY), ...CANDS };
console.log(''.padEnd(40), Object.keys(SCEN).map((s, i) => pad('(' + (i + 1) + ')', 8)).join(''), '   ', Object.keys(SCEN).map((s, i) => '(' + (i + 1) + ') ' + s).join('; '));
for (const [name, fn] of Object.entries(BOOT)) {
  const cells = Object.values(SCEN).map((scen, si) => { const rnd = mulberry32(8340 + si); let s2 = 0; for (let r = 0; r < N; r++) s2 += (fn(scen(read(levels(rnd), 30), rnd)) - POP) ** 2; return pad(f1(Math.sqrt(s2 / N)), 8); });
  console.log(name.padEnd(40), cells.join(''));
}

head('6. Following a real change of rate: percent of the change reported after m of 30 steps are at the new rate');
const MS = [1, 2, 4, 6, 7, 8, 10, 12, 15, 18, 20, 23, 26, 30];
const FOLLOW = ['plain mean (last - first) / days', 'A least squares, 90 d', 'D median step', 'E trimmed mean of steps, 20%', 'E trimmed mean of steps, 25%', 'E trimmed mean of steps, 33%', 'F mean of unflagged steps'];
console.log('noise-free, the new rate far outside the old steps'.padEnd(52), MS.map((m) => pad(m, 5)).join(''));
for (const name of FOLLOW) console.log(name.padEnd(52), MS.map((m) => { const p = []; let y = 0; for (let i = 0; i <= 30; i++) { p.push({ t: i * 3 * DAY, y }); y += i >= 30 - m ? -900 : -300; } return pad(((100 * (BOOT[name](p) + 100)) / -200).toFixed(0), 5); }).join(''));
for (const delta of [-252, 252, -1000, 1000]) {
  console.log(('measured noise, change of ' + delta + ' GB/day').padEnd(52), MS.map((m) => pad(m, 5)).join(''));
  for (const name of FOLLOW) {
    const rnd = mulberry32(83410), acc = MS.map(() => 0), fn = BOOT[name];
    for (let r = 0; r < 1500; r++) { const base = read(levels(rnd), 30), old = fn(base); MS.forEach((m, j) => { acc[j] += (fn(base.map((q, i) => ({ t: q.t, y: q.y + Math.max(0, i - (30 - m)) * 3 * delta }))) - old) / delta; }); }
    console.log(name.padEnd(52), acc.map((s) => pad(((100 * s) / 1500).toFixed(0), 5)).join(''));
  }
}

head('7. Window length, chosen method: root-mean-square error (GB/day) against ' + f1(POP));
for (const n of [7, 8, 10, 11, 12, 15, 20, 30]) {
  const rnd = mulberry32(83420); let a = 0, b = 0, c = 0;
  for (let r = 0; r < N; r++) { const p = read(levels(rnd), n); a += (CHOSEN(p) - POP) ** 2; b += (CHOSEN(rise(p, 1 + Math.floor(rnd() * (n - 1)))) - POP) ** 2; c += (CHOSEN(fall(p, 1 + Math.floor(rnd() * (n - 2)))) - POP) ** 2; }
  console.log('steps', pad(n, 2), ' samples', pad(n + 1, 2), ' days', pad(n * 3, 2), ' set aside per end', Math.floor(n / 4), ' no jump', pad(f1(Math.sqrt(a / N)), 6), ' with the rise', pad(f1(Math.sqrt(b / N)), 6), ' with the fall', pad(f1(Math.sqrt(c / N)), 6));
}

head('8. Sample step, chosen method, 90 days: mean rate and root-mean-square error (GB/day) against ' + f1(POP));
for (const every of [1, 2, 6, 14]) {
  const rnd = mulberry32(83430), cnt = Math.floor(180 / every); let s = 0, a = 0, b = 0;
  for (let r = 0; r < N; r++) { const p = read(levels(rnd), cnt, every), v = CHOSEN(p), k = (1 + Math.floor(rnd() * 179)) * 43200; s += v; a += (v - POP) ** 2; b += (CHOSEN(p.map((q) => ({ t: q.t, y: q.y + (q.t >= k ? 9863.8 : 0) }))) - POP) ** 2; }
  console.log('step', pad(every * 12, 3) + ' h', ' steps', pad(cnt, 3), ' mean', pad(f1(s / N), 7), ' no jump', pad(f1(Math.sqrt(a / N)), 6), ' with one 9863.8 GB rise', pad(f1(Math.sqrt(b / N)), 6));
}
const end12 = h12.findIndex((q) => q.t === Date.parse('2026-11-12T00:00:00Z') / 1000);
for (const every of [1, 2, 6, 14]) { const sub = (a) => { const o = []; for (let i = end12; i >= 0 && a[end12].t - a[i].t <= 90 * DAY; i -= every) o.unshift(a[i]); return o; }; console.log('measured series to 2026-11-12, step', pad(every * 12, 3) + ' h: HaynesTower', pad(f1(CHOSEN(sub(h12))), 7), ' music', pad(f1(CHOSEN(sub(m12))), 7)); }

head('9. The flat cut: share of trend-free replicates called a trend when |rate| > c standard errors');
for (const n of [12, 30]) {
  const rnd = mulberry32(83440), cuts = [1, 1.5, 2, 2.5, 3], hits = cuts.map(() => 0); let sd = 0, se = 0;
  for (let r = 0; r < N; r++) { const p = read(levels(rnd), n).map((q, i) => ({ t: q.t, y: q.y - POP * i * 3 })), v = CHOSEN(p), e = trimSe(p); sd += v * v; se += e; cuts.forEach((c, j) => { if (Math.abs(v) > c * e) hits[j]++; }); }
  console.log('steps', n, cuts.map((c, j) => c + ' se: ' + ((100 * hits[j]) / N).toFixed(1) + '%').join('   '), '  spread of the rate', f1(Math.sqrt(sd / N)), ' mean standard error', f1(se / N));
}

head('10. The chosen method on the recorded series, step by step');
for (const [name, p] of [['HaynesTower', ht], ['music', mu]]) {
  const d = steps(p).map((v) => Math.round(v * 30) / 10).sort((a, b) => a - b), g = Math.floor(d.length / 4), mid = d.slice(g, d.length - g);
  const total = Math.round(sum(mid) * 10) / 10, rate = total / mid.length / 3, last = p[p.length - 1], se = trimSe(p);
  console.log(name, 'sorted steps (GB per 3 days):', d.map(f1).join(' '));
  console.log(name, 'set aside', g, 'at each end; the middle', mid.length, 'sum to', f1(total), '; rate', rate, 'GB/day; standard error', se.toFixed(3), 'GB/day; rate / se', (rate / se).toFixed(2));
  console.log(name, 'days to 0 from', last.y, 'GB:', last.y / -rate, '->', isoSec(last.t + (last.y / -rate) * DAY), '(unix ' + Math.round(last.t + (last.y / -rate) * DAY) + ')');
  if (name === 'HaynesTower') console.log(name, 'days to a 50000 GB floor:', (last.y - 50000) / -rate, '->', isoSec(last.t + ((last.y - 50000) / -rate) * DAY), '(unix ' + Math.round(last.t + ((last.y - 50000) / -rate) * DAY) + ')');
}
console.log('music, as of each sample from 2026-10-25 (GB/day):'); for (let n = 25; n <= 31; n++) { const p = mu.slice(0, n); console.log('  ', isoDay(p[n - 1].t), ' chosen', pad(f1(CHOSEN(p)), 6), ' least squares', pad(f1(ols(p).slope), 6), ' plain mean', pad(f1((p[n - 1].y - p[0].y) / ((p[n - 1].t - p[0].t) / DAY)), 6)); }
