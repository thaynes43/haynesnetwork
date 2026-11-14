// Read-only collector, stdin in the web pod. Replica rows substitute __CACHE__.
// Only explicitly selected household fields leave the pod; errors never contain upstream text.
const cacheRows = __CACHE__;
const cache = new Map();
const numeric = x => Number.isSafeInteger(x) && x > 0 ? x : undefined;
const decimal = x => typeof x === 'string' && /^\d+$/.test(x) ? numeric(Number(x)) : undefined;
const imdb = x => typeof x === 'string' && /^tt\d+$/.test(x.trim()) && /[1-9]/.test(x) ? x.trim() : undefined;
const normalize = x => ({tmdbId:numeric(x.tmdbId),tvdbId:numeric(x.tvdbId),imdbId:imdb(x.imdbId)});
const usable = x => Object.values(x).some(x => x !== undefined);
const specs=[
 ['haynesops','TAUTULLI_URL','TAUTULLI_API_KEY','http://tautulli.media.svc.cluster.local:8181'],
 ['hayneskube','TAUTULLI_K8PLEX_URL','TAUTULLI_K8PLEX_API_KEY','http://tautulli-k8plex.media.svc.cluster.local:8181'],
 ['haynestower','TAUTULLI_HAYNESTOWER_URL','TAUTULLI_HAYNESTOWER_API_KEY',null]
];
const result={measured_at:new Date().toISOString(),instances:[],titles:[],unattributable:[]};
let stage='cache',instance='none',status=0;
try {
 for (const r of cacheRows) {
  const fitting=r.arr_kind==='radarr'?'movie':r.arr_kind==='sonarr'?'show':null;
  if (!fitting || fitting!==r.media_type) continue;
  const ids=normalize({tmdbId:r.tmdb_id,tvdbId:r.tvdb_id,imdbId:r.imdb_id});
  if (usable(ids)) cache.set(`${r.slug}\0${r.rating_key}`,{arrKind:r.arr_kind,...ids});
 }
 for (const [slug,urlVar,keyVar,fallback] of specs) {
  instance=slug; stage='configuration'; status=0;
  const apiKey=process.env[keyVar]?.trim();
  const origin=process.env[urlVar]?.trim() || fallback;
  if (!apiKey || !origin) throw null;
  async function get(cmd,params) {
   status=0; stage='url';
   const url=new URL('/api/v2',origin);
   if (!['http:','https:'].includes(url.protocol)) throw null;
   for (const [k,v] of Object.entries({apikey:apiKey,cmd,...params})) url.searchParams.set(k,String(v));
   stage='fetch';
   const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
   status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:0;
   stage='body';
   const text=await response.text();
   stage='json';
   const body=JSON.parse(text);
   stage='api';
   if (cmd==='get_metadata' && status===400 && typeof body?.response?.message==='string' && /unable to retrieve metadata/i.test(body.response.message)) return null;
   if (!response.ok || body?.response?.result!=='success') throw null;
   return body.response.data;
  }
  const groups=new Map();
  const report={slug,pages:0,rows:0,finished:false,unjoined:0,metadataCalls:0};
  for (let page=0;page<158;page++) {
   const payload=await get('get_history',{length:500,start:page*500});
   stage='history';
   const rows=payload?.data; if (!Array.isArray(rows)) throw null;
   report.pages++; report.rows+=rows.length;
   for (const r of rows) {
    const arrKind=r.media_type==='movie'?'radarr':r.media_type==='episode'?'sonarr':null;
    const ratingKey=arrKind==='radarr'?r.rating_key:r.grandparent_rating_key;
    if (!arrKind || ratingKey===null || ratingKey===undefined || String(ratingKey).trim()==='') continue;
    const key=`${arrKind}\0${ratingKey}`;
    const title=arrKind==='radarr'?r.title:r.grandparent_title;
    // History year is only a lead; for episodes it can be the episode's year, not the show's.
    const year=Number(r.year);
    const g=groups.get(key) || {arrKind,ratingKey:String(ratingKey),playCount:0,lastViewedAt:null,oldest:null,
      title:typeof title==='string'?title:null,year:Number.isInteger(year)&&year>0?year:null};
    g.playCount++;
    const secs=Number(r.stopped ?? r.date), ms=secs*1000;
    const when=Number.isFinite(ms)&&ms>0&&ms<=8640000000000000?new Date(ms).toISOString():null;
    if (when && (!g.lastViewedAt || when>g.lastViewedAt)) g.lastViewedAt=when;
    if (when && (!g.oldest || when<g.oldest)) g.oldest=when;
    groups.set(key,g);
   }
   if (rows.length<500) {report.finished=true;break;}
  }
  stage='paging'; if (!report.finished) throw null;
  const unresolved=(g,reason) => {
   report.unjoined++;
   result.unattributable.push({slug,...g,reason});
  };
  for (const g of groups.values()) {
   let ids=cache.get(`${slug}\0${g.ratingKey}`);
   if (ids?.arrKind!==g.arrKind) ids=null;
   if (!ids) {
    report.metadataCalls++;
    const meta=await get('get_metadata',{rating_key:g.ratingKey});
    stage='metadata';
    if (!meta || Object.keys(meta).length===0) {unresolved(g,'metadata_unavailable');continue;}
    if (meta.media_type && meta.media_type!==(g.arrKind==='radarr'?'movie':'show')) {unresolved(g,'kind_refused');continue;}
    const raw={};
    for (const guid of meta.guids || []) {
     const [scheme,id]=guid.split('://');
     if (scheme==='tmdb') {const n=decimal(id); if(n!==undefined) raw.tmdbId=n;}
     if (scheme==='tvdb') {const n=decimal(id); if(n!==undefined) raw.tvdbId=n;}
     if (scheme==='imdb') raw.imdbId=id;
    }
    ids=normalize(raw);
   }
   if (!usable(normalize(ids))) {unresolved(g,'no_usable_id');continue;}
   result.titles.push({slug,arrKind:g.arrKind,ratingKey:g.ratingKey,playCount:g.playCount,lastViewedAt:g.lastViewedAt,guids:normalize(ids)});
  }
  result.instances.push(report);
 }
 stage='output'; console.log(JSON.stringify(result));
} catch {
 const stages=['cache','configuration','url','fetch','body','json','api','history','metadata','paging','output'];
 console.error(JSON.stringify({stage:stages.includes(stage)?stage:'unknown',
  instance:specs.some(s=>s[0]===instance)?instance:'none',status}));
 process.exitCode=1;
}
