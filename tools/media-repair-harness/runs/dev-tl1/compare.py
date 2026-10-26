"""dev-tl1 analysis (OpenProject #208): handed vs must-ask on one model. Reads only the two run folders (their score.json and case records).

    python3 compare.py <handed_run> <must_ask_run>

Differing cases are those whose must-ask record has evidence_handover.withheld; the rest are the identical-input noise control."""
import json,sys,os,collections
def load(run):
    s=json.load(open(os.path.join(run,'score.json')))['cases']
    recs={}
    for cid in s:
        p=os.path.join(run,cid+'.json')
        if os.path.exists(p): recs[cid]=json.load(open(p))
    return s,recs
h,m=sys.argv[1],sys.argv[2]
sh,rh=load(h); sm,rm=load(m)
eh=lambda r:(r.get('evidence_handover') or {})
diff=[c for c in sm if c in rm and eh(rm[c]).get('withheld')]
same=[c for c in sm if c not in diff]
def acc(s,cs): cs=[c for c in cs if c in s]; return sum(s[c]['correct'] for c in cs),len(cs)
print('differing cases',len(diff),'identical-input',len(same))
print('correct on differing: handed %d/%d  must-ask %d/%d'%(acc(sh,diff)+acc(sm,diff)))
print('correct on identical-input (noise control): handed %d/%d  must-ask %d/%d'%(acc(sh,same)+acc(sm,same)))
print('correct all 73: handed %d/%d  must-ask %d/%d'%(acc(sh,list(sh))+acc(sm,list(sm))))
idc=[c for c in diff if sm[c]['truth']=='identity_mismatch']; ida=[c for c in sm if sm[c]['truth']=='identity_mismatch']
print('identity_mismatch differing: handed %d/%d must-ask %d/%d ; all identity: handed %d/%d must-ask %d/%d'%(acc(sh,idc)+acc(sm,idc)+acc(sh,ida)+acc(sm,ida)))
pc=collections.defaultdict(lambda:[0,0,0,0])
for c in diff:
    t=sm[c]['truth']; pc[t][0]+=sh[c]['correct']; pc[t][1]+=sm[c]['correct']; pc[t][2]+=1
print('per class on differing (handed/must-ask/n):',{k:'%d/%d/%d'%tuple(v[:3]) for k,v in sorted(pc.items())})
calls_h=sum(len(rh[c]['tool_calls']) for c in diff if c in rh); calls_m=sum(len(rm[c]['tool_calls']) for c in diff)
print('tool calls on differing: handed',calls_h,'must-ask',calls_m)
w=o=n=0; nocall=0
for c in diff:
    e=eh(rm[c]); wl=e.get('withheld') or []; ob=e.get('obtained_by_call') or e.get('obtained') or []
    w+=len(wl); o+=len(ob)
    if not rm[c]['tool_calls']: nocall+=1
print('withheld entries',w,'obtained by a call',o,'| must-ask cases with zero calls',nocall,'of',len(diff))
print('forced: handed',sum(sh[c]['forced'] for c in sh),'must-ask',sum(sm[c]['forced'] for c in sm))
flip=collections.Counter((sh[c]['correct'],sm[c]['correct']) for c in diff); print('flips (handed,mustask):',dict(flip))
print('evidence_handover keys:',list(eh(rm[diff[0]]).keys()))
