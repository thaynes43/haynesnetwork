// Projection, not a prediction. No network, credentials or account viewing.
// Run: node --experimental-strip-types .agents/context/2026-11-14-852-projection.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { forecastFreeSpace } from '../../packages/domain/src/storage-forecast.ts';

const DAY = 86400;
const TB = 1e12;
// Recorded by the coordinator 2026-11-13T16:36Z; work-order query, GB (1e9).
const freeGB = [97170.9,96487.7,95534.6,95096,93523.7,92515.1,92716.6,90963.6,90446.7,
  90004.6,89442.3,89604.7,88983,88636.5,87970,86825.7,86498.4,85466.7,85654.4,84428.1,
  84711,83941.8,82920.9,82047.5,80932.5,80198.3,80066.7,78500.2,78277,80138.3,88140.8];
const start = Date.parse('2026-08-14T00:00:00Z') / 1000;
// Replica SELECT 2026-11-14, completed-batch deleted_size_bytes from the series start; UTC.
const deletions = [
 ['2026-08-15T21:46:33Z',1018541717882],['2026-08-22T22:46:16Z',694821753054],
 ['2026-08-29T23:46:21Z',1368541139008],['2026-09-06T00:46:22Z',999384236975],
 ['2026-09-13T04:45:15Z',771078185884],['2026-09-14T20:45:10Z',372082386455],
 ['2026-09-20T05:45:40Z',842610549897],['2026-09-28T02:46:02Z',1059247756773],
 ['2026-10-05T03:46:11Z',752125114805],['2026-10-12T04:46:12Z',976035531939],
 ['2026-10-19T05:45:33Z',122143916926],['2026-11-06T15:46:13Z',3246674077176],
 ['2026-11-13T16:45:55Z',1758002511335],
].map(([date,bytes]) => ({ t: Date.parse(date)/1000, bytes }));
const samples = freeGB.map((g,i) => ({ t:start+i*3*DAY, freeBytes:Math.round(g*1e9) }));
const adjusted = samples.map(s => ({ ...s, freeBytes:s.freeBytes-deletions.filter(d=>d.t<=s.t).reduce((n,d)=>n+d.bytes,0) }));
const now = Date.parse('2026-11-14T07:03:09Z') / 1000;
const total = 529958515245056;
const initialFree = 88152002002944;
const targetFree = Math.round(total * .25);
const rate = forecastFreeSpace({ samples:adjusted, targetFreeBytes:targetFree, now }).rateBytesPerDay;
assert(rate < 0);
const intake = -rate;
// Trailing 90 days at the measured instant excludes the 2026-08-15 sweep. Replica SELECT, 2026-11-14.
const saved = 1897158268845;
const deleted = 12590664773772 + 372082386455;
const yieldRate = deleted/(saved+deleted);
const input = JSON.parse(readFileSync(new URL('./2026-11-14-852-inputs.json',import.meta.url),'utf8'));
const movie = input.pool.find(p=>p.media_kind==='movie');
const sizes = movie.unposted_sizes;
assert.equal(sizes.length, movie.titles-movie.posted_titles);
assert.equal(sizes.reduce((n,b)=>n+b,0), movie.bytes-movie.posted_bytes);
assert.equal(samples.length,31);
assert.equal(deletions.length,13);
const cap = 3591025375575;
const floor = 130604353957;
const horizon = 30; // Coordinator decision, not a measured rate or deadline.
const window = 7; // Measured current window.
const titlesCap = 50; // Measured current movie maxItems; TV pool zero.

function select(pool, ask) {
  const chosen=[];
  let bytes=0;
  for (let i=0;i<pool.length;i++) {
    if (bytes+pool[i]>ask) continue;
    chosen.push(i); bytes+=pool[i];
    if(chosen.length>=titlesCap || bytes>=ask) break;
  }
  return { chosen, bytes };
}
// Favourable unlimited pool: every future window has a fresh copy of today's largest fitting
// capped batch. This is an estimated supply model, not a claim that such titles arrive.
const unlimitedSizes = select(sizes, cap).chosen.map(i=>sizes[i]);
function project(unlimited) {
  let free=initialFree;
  let pool=[...sizes];
  let nextDelete=movie.posted_bytes*yieldRate; // Open batch counted once, deleting at day 7.
  let cumulative=0;
  let exhaustedPostDay=null;
  const result=[];
  for(let day=1;day<=120;day++) {
    free-=intake;
    if(day%window===0) {
      free+=nextDelete; cumulative+=nextDelete; nextDelete=0;
      const required=Math.max(0,(targetFree-free)-rate*horizon)*Math.min(1,window/horizon);
      const raw=required/yieldRate;
      const ask=raw<=0 || (free>=targetFree && raw<floor) ? 0 : Math.min(cap,Math.max(floor,Math.floor(raw)));
      if(unlimited === 'measured-sizes') pool=[...unlimitedSizes];
      // Mathematical upper bound: enough fitting titles to fill the ceiling under the title cap.
      // It asserts no measured size distribution or supply; the hypothetical sizes sum to cap.
      if(unlimited === 'ceiling') pool=Array.from({length:titlesCap},(_,i)=>Math.floor(cap/titlesCap)+(i<cap%titlesCap?1:0));
      const selected=select(pool,ask);
      nextDelete=selected.bytes*yieldRate;
      pool=pool.filter((_,i)=>!selected.chosen.includes(i));
      if(!unlimited && pool.length===0 && exhaustedPostDay===null) exhaustedPostDay=day;
    }
    if([30,60,120].includes(day)) result.push({day, deletedTB:cumulative/TB, freeTB:free/TB,
      usedPct:100*(1-free/total), gapTB:Math.max(0,targetFree-free)/TB});
  }
  return { exhaustedPostDay, rows:result };
}
// Necessary recovery arithmetic (estimates): same constant intake/yield and delayed first deletion.
const openExpectedDeleted = movie.posted_bytes * yieldRate;
const recovery = [60,120].map(deadlineDays => {
  const requiredFreedBytes = targetFree - initialFree + intake * deadlineDays;
  const futureDeletions = Math.floor(deadlineDays / window) - 1; // open batch first, day 7
  const newProposedBytes = (requiredFreedBytes - openExpectedDeleted) / yieldRate;
  return { deadlineDays, futureDeletions, requiredFreedTB: requiredFreedBytes/TB,
    newProposedSupplyTB: newProposedBytes/TB, averageBatchTB: newProposedBytes/futureDeletions/TB };
});
const balanceProposals = intake * window / yieldRate;
const ceilingNetGain = cap * yieldRate - intake * window;
const repeatedBatch = unlimitedSizes.reduce((n,b)=>n+b,0);
assert.equal(recovery[0].futureDeletions,7);
assert.equal(recovery[1].futureDeletions,16);
console.log(JSON.stringify({ estimatedRecovery: { assumption:'Constant historical intake/yield, open batch once at day 7, new deletions from day 14; necessary bounds only',
  netGainPerCycleAtCeilingTB:ceilingNetGain/TB,
  netGainPerCycleAtRepeatedSelectionTB:(repeatedBatch*yieldRate-intake*window)/TB,
  proposalsPerCycleToBalanceTB:balanceProposals/TB, recovery }, measuredAt:new Date(now*1000).toISOString(), intakeGBPerDay:intake/1e9,
  unadjustedGBPerDay:forecastFreeSpace({samples,targetFreeBytes:targetFree,now}).rateBytesPerDay/1e9,
  yieldRate, sampleCount:samples.length, deletionCount:deletions.length,
  unpostedTitles:sizes.length, unpostedBytes:sizes.reduce((n,b)=>n+b,0),
  unlimitedBatchTitles:unlimitedSizes.length, unlimitedBatchBytes:unlimitedSizes.reduce((n,b)=>n+b,0),
  unlimitedCeilingBound:project('ceiling'), unlimitedMeasuredSizes:project('measured-sizes'), today:project(false) },null,2));
