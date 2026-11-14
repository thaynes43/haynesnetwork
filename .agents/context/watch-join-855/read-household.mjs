// Read-only census input. Run in the existing web pod; credentials stay in its environment.
// The caller substitutes replica cache rows for __CACHE__. Output has no account fields.
const cacheRows = __CACHE__;
const cache = new Map();
const numeric = x => Number.isSafeInteger(x) && x > 0 ? x : undefined;
const imdb = x => typeof x === 'string' && /^tt\d+$/.test(x.trim()) && /[1-9]/.test(x) ? x.trim() : undefined;
const normalize = x => ({tmdbId:numeric(x.tmdbId),tvdbId:numeric(x.tvdbId),imdbId:imdb(x.imdbId)});
const usable = x => Object.values(x).some(x => x !== undefined);
for (const r of cacheRows) {
  const fitting = r.arr_kind === 'radarr' ? 'movie' : r.arr_kind === 'sonarr' ? 'show' : null;
  if (!fitting || fitting !== r.media_type) continue;
  const ids=normalize({tmdbId:r.tmdb_id,tvdbId:r.tvdb_id,imdbId:r.imdb_id});
  if (usable(ids)) cache.set(`${r.slug}\0${r.rating_key}`,{arrKind:r.arr_kind,...ids});
}
const specs=[
 ['haynesops','TAUTULLI_URL','TAUTULLI_API_KEY','http://tautulli.media.svc.cluster.local:8181'],
 ['hayneskube','TAUTULLI_K8PLEX_URL','TAUTULLI_K8PLEX_API_KEY','http://tautulli-k8plex.media.svc.cluster.local:8181'],
 ['haynestower','TAUTULLI_HAYNESTOWER_URL','TAUTULLI_HAYNESTOWER_API_KEY',null]
];
const result={measured_at:new Date().toISOString(),instances:[],titles:[]};
try {
 for (const [slug,urlVar,keyVar,fallback] of specs) {
  const apiKey=process.env[keyVar]?.trim();
  const origin=process.env[urlVar]?.trim() || fallback;
  if (!apiKey || !origin) throw new Error(`missing in-pod variable for ${slug}`);
  async function get(cmd,params) {
   const url=new URL('/api/v2',origin);
   for (const [k,v] of Object.entries({apikey:apiKey,cmd,...params})) url.searchParams.set(k,String(v));
   let response;
   try {response=await fetch(url,{signal:AbortSignal.timeout(30000)});} catch {throw new Error(`${slug}: read failed`);}
   const body=await response.json();
   if (cmd==='get_metadata' && response.status===400 && /unable to retrieve metadata/i.test(body.response?.message || '')) return null;
   if (!response.ok || body.response?.result!=='success') throw new Error(`${slug}: API refusal/status ${response.status}`);
   return body.response.data;
  }
  const groups=new Map();
  const report={slug,pages:0,rows:0,finished:false,unjoined:0,metadataCalls:0};
  for (let page=0;page<158;page++) {
   const payload=await get('get_history',{length:500,start:page*500});
   const rows=payload.data; if (!Array.isArray(rows)) throw new Error(`${slug}: invalid history`);
   report.pages++;report.rows+=rows.length;
   for (const r of rows) {
    const arrKind=r.media_type==='movie'?'radarr':r.media_type==='episode'?'sonarr':null;
    const ratingKey=arrKind==='radarr'?r.rating_key:r.grandparent_rating_key;
    if (!arrKind || ratingKey===null || ratingKey===undefined || String(ratingKey).trim()==='') continue;
    const key=`${arrKind}\0${ratingKey}`;
    const g=groups.get(key) || {arrKind,ratingKey:String(ratingKey),playCount:0,lastViewedAt:null};
    g.playCount++;
    const secs=Number(r.stopped ?? r.date);
    const when=Number.isFinite(secs)&&secs>0?new Date(secs*1000).toISOString():null;
    if (when && (!g.lastViewedAt || when>g.lastViewedAt)) g.lastViewedAt=when;
    groups.set(key,g);
   }
   if (rows.length<500) {report.finished=true;break;}
  }
  if (!report.finished) throw new Error(`${slug}: incomplete history`);
  for (const g of groups.values()) {
   let ids=cache.get(`${slug}\0${g.ratingKey}`);
   if (ids?.arrKind!==g.arrKind) ids=null;
   if (!ids) {
    report.metadataCalls++;
    const meta=await get('get_metadata',{rating_key:g.ratingKey});
    if (!meta || Object.keys(meta).length===0) {report.unjoined++;continue;}
    if (meta.media_type && meta.media_type!==(g.arrKind==='radarr'?'movie':'show')) {report.unjoined++;continue;}
    const raw={};
    for (const guid of meta.guids || []) {
     const [scheme,id]=guid.split('://');
     if (scheme==='tmdb') raw.tmdbId=Number(id);
     if (scheme==='tvdb') raw.tvdbId=Number(id);
     if (scheme==='imdb') raw.imdbId=id;
    }
    ids=normalize(raw);
   }
   if (!usable(normalize(ids))) {report.unjoined++;continue;}
   result.titles.push({slug,...g,guids:normalize(ids)});
  }
  result.instances.push(report);
 }
 console.log(JSON.stringify(result));
} catch (error) {console.error(error.message);process.exitCode=1;}
