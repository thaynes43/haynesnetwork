# F10 final sweep, flag pass (cheap signals only). Input: JSON lines, one per item, from Audiobookshelf (abs) or Kavita/disk
# (kavita). Output: one JSON line per flagged item with the signals that fired. Whisper / text samples confirm afterwards.
import json,re,sys,unicodedata
TOK={
 'de':'der die das und ein eine einer von mit für fuer nicht ist im zum zur des dem den kapitel teil folge band ungekürzt ungekuerzt ungekrzt gekürzt hörbuch hoerbuch hörspiel roman erzählt gelesen sprecher auf aus wie über ueber und dunkle bedrohung chroniken zwischen sternen geschichte geschichten'.split(),
 'nl':'het een hoofdstuk deel luisterboek voorgelezen verhaal boek van'.split(),
 'es':'los las del capítulo capitulo libro audiolibro novela una por para destructora espadas'.split(),
 'fr':'les des du et chapitre tome livre audio roman une pour par sur autrice série'.split(),
 'it':'il gli della delle di capitolo audiolibro romanzo potere pace interiore scontro finale'.split(),
 'sv':'och ljudbok kapitel svensk utgåva bok'.split(),
 'no':'og lydbok kapittel norsk'.split(),
 'da':'og lydbog kapitel dansk'.split(),
}
# words that are also English or common in English titles/names: never count them alone
WEAK={'die','der','den','van','de','del','la','le','et','il','di','og','band','roman','boek','bok','teil','folge','des','une','par','pour','sur','an','on','in','am'}
MARK=['ungekürzt','ungekuerzt','ungekrzt','gekürzt','hörbuch','hoerbuch','hörspiel','kapitel','luisterboek','audiolibro','livre audio','ljudbok','lydbok','lydbog',
      'svensk','deutsch','german','dansk','norsk','surgicalremnants','fkk','cravings','fuer kidz','hörverlag','hoerverlag','argon','lübbe','luebbe',
      'random house audio deutschland','random house audio, deutschland','der audio verlag','wunderkind','sauerländer','oetinger','jumbo','hörbuchhamburg',
      'hoerbuch hamburg','steinbach','silberfisch','goyalit','osterwold','cbj audio','penhaligon','heyne','blanvalet','tome ','capítulo','chapitre','hoofdstuk','kapittel']
NARR=['johannes steck','simon jäger','reinhard kuhnert','birgitta assheuer','constanze buttmann','ulrich nöten','andreas fröhlich','rufus beck','david nathan',
      'oliver rohrbeck','stefan kaminski','detlef bierstedt','thomas fritsch','gert heidenreich','katharina thalbach','wolfgang pampel','dietmar wunder',
      'matthias koeberlin','christoph maria herbst','jürgen prochnow','sascha rotermund','robert stadlober','julia nachtmann','jona mues','marie bierstedt']
ENLANG={'','en','eng','english','en-us','en-gb','xxx','und','none'}
def strip(s): return unicodedata.normalize('NFC',s or '')
def words(s): return re.findall(r"[a-zà-ÿßæøå]+",strip(s).lower())
def dia(s): return bool(re.search(r'[äöüßàâçéèêëîïôûùÿñåøæœ]',strip(s).lower()))
def heb(s): return bool(re.search(r'[֐-׿]',s or ''))
def score_text(s):
    w=words(s); hits={}
    for lang,ts in TOK.items():
        h=[t for t in w if t in ts and t not in WEAK]
        if h: hits[lang]=h
    return hits
out=0
for line in sys.stdin:
    it=json.loads(line); sig=[]
    texts=[it.get('title') or '',it.get('subtitle') or '',it.get('rel','').split('/',1)[-1]]+[t.get('al') or '' for t in it.get('tags',[])]+[t.get('ti') or '' for t in it.get('tags',[])][:3]+it.get('files',[])[:40]
    blob=' | '.join(texts)
    low=strip(blob).lower()
    m=sorted({k for k in MARK if k in low})
    if m: sig.append('marker:'+','.join(m))
    th=score_text(' '.join(texts[:3]+[t.get('al') or '' for t in it.get('tags',[])]))
    strong={k:v for k,v in th.items() if len(set(v))>=1}
    if strong: sig.append('stopwords:'+json.dumps(strong,ensure_ascii=False))
    if dia(' '.join(texts[:3]+[t.get('al') or '' for t in it.get('tags',[])])): sig.append('diacritics(title/album/folder)')
    if any(dia(f) for f in it.get('files',[])[:40]): sig.append('diacritics(files)')
    if heb(blob): sig.append('hebrew')
    nar=' '.join((it.get('narrators') or [])+[t.get('co') or '' for t in it.get('tags',[])]).lower()
    nn=[n for n in NARR if n in nar]
    if nn: sig.append('narrator:'+','.join(nn))
    if dia(nar): sig.append('narrator-diacritics:'+nar[:60])
    langs={(it.get('language') or '').strip().lower()}|{(t.get('la') or '').strip().lower() for t in it.get('tags',[])}|{(t.get('lang') or '').strip().lower() for t in it.get('tags',[])}
    bad=sorted(l for l in langs if l not in ENLANG)
    if bad: sig.append('lang-tag:'+','.join(bad))
    pub=' '.join([it.get('publisher') or '']+[t.get('pu') or '' for t in it.get('tags',[])]).lower()
    if any(k in pub for k in ('verlag','hörverlag','deutschland','argon','lübbe','wunderkind','sauerländer','editions','ediciones','edizioni','uitgeverij','förlag','forlag')): sig.append('publisher:'+pub[:60])
    cm=' '.join(t.get('cm') or '' for t in it.get('tags',[])).lower()
    if any(k in cm for k in ('surgicalremnants','fkk','cravings')): sig.append('comment:'+cm[:60])
    if sig:
        out+=1; print(json.dumps({'id':it['id'],'rel':it['rel'],'title':it.get('title'),'n':it.get('n'),'sig':sig},ensure_ascii=False))
print(json.dumps({'flagged':out}),file=sys.stderr)
