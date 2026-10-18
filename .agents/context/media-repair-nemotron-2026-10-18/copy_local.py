"""One serial owned exact-package copy/hash; original store never written."""
import concurrent.futures,datetime,json,re,subprocess,time
from pathlib import Path
import run_text as base
ROOT=Path(__file__).resolve().parent
LOCAL='/tmp/media-repair-nemotron-1018-local'

def main():
 proof=json.loads((ROOT/'registry-proof.json').read_text());layers=[proof['manifest']['config']]+proof['manifest']['layers']
 layers.append({'digest':'sha256:'+proof['manifest_sha256']})
 lines=['set -e',"printf 'COPY_PID=%s\\n' \"$$\" >&2",'child=','trap \'test -z "$child" || kill "$child" 2>/dev/null; exit 143\' TERM INT',f'test ! -e {LOCAL}',f'mkdir -m 700 {LOCAL}',f'mkdir -p {LOCAL}/models/blobs {LOCAL}/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt']
 expected={}
 for layer in layers:
  digest=layer['digest'];assert re.fullmatch(r'sha256:[a-f0-9]{64}',digest)
  filename=digest.replace(':','-');src='/models/blobs/'+filename;dst=LOCAL+'/models/blobs/'+filename;expected[dst]=digest.split(':')[1]
  lines += [f'printf "COPY {filename}\\n"',f'nice -n 19 cp -- {src} {dst} & child=$!; wait "$child"; child=',f'nice -n 19 sha256sum {dst} & child=$!; wait "$child"; child=',f'chmod 400 {dst}']
 manifest='/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt/74b-a9b';destination=LOCAL+'/models/manifests/registry.ollama.ai/library/nemotron-3.5-bolt/74b-a9b'
 expected[destination]=json.loads((ROOT/'checksums.json').read_text())['manifest']['installed_wrapper_sha256']
 lines += [f'cp -- {manifest} {destination}',f'sha256sum {destination}',f'stat -c "%u %a %F" {LOCAL}',f'df -B1 -T {LOCAL}']
 script=('\n'.join(lines)+'\n').encode();(ROOT/'local-copy-script.sh').write_bytes(script)
 remote={};marker='media-repair-nemotron-owned-copy'
 def copy():
  start=time.monotonic();proc=subprocess.Popen(base.runtime.PREFIX[:4]+['-i']+base.runtime.PREFIX[4:]+['timeout','600','bash','-s',marker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  proc.stdin.write(script);proc.stdin.close();proc.stdin=None
  first=proc.stderr.readline().decode(errors='replace');m=re.fullmatch(r'COPY_PID=(\d+)\n',first)
  if m:remote['pid']=m[1]
  out,err=proc.communicate(timeout=610)
  return {'wall_seconds':time.monotonic()-start,'exit_code':proc.returncode,'stdout':out.decode(errors='replace'),'stderr':first+err.decode(errors='replace')}
 snapshots=[];last_size=-1;last_progress=time.monotonic();pressure=0
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  future=executor.submit(copy)
  while not future.done():
   r=base.resources();v=base.values(r)
   status=subprocess.run(base.runtime.PREFIX+['bash','-c',f'du -sb {LOCAL} 2>/dev/null; cat /sys/fs/cgroup/memory.pressure'],capture_output=True,text=True,timeout=10)
   m=re.search(r'^(\d+)\s',status.stdout);size=int(m[1]) if m else 0
   if size>last_size:last_progress=time.monotonic()
   last_size=size;full=re.search(r'^full avg10=([\d.]+)',status.stdout,re.M);pressure=pressure+1 if full and float(full[1])>10 else 0
   snapshots.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'resources':r,'values':v,'copy_status':status.stdout,'bytes':size})
   (ROOT/'local-copy-samples.json').write_text(json.dumps(snapshots,indent=2)+'\n')
   print('LOCAL_COPY',size,'gpu',v['gpu_used_mib'],'noninactive',v['cgroup_noninactive'],flush=True)
   reason=None
   if not base.healthy(r) or r['snapshot']['compute_processes']:reason='Resource_OOM_or_foreign_compute'
   elif pressure>=2:reason='Harmful_memory_pressure'
   elif time.monotonic()-last_progress>120:reason='No_copy_progress120s'
   elif datetime.datetime.now(datetime.timezone.utc)>=datetime.datetime.fromisoformat('2026-10-18T22:25:00+00:00'):reason='Absolute_deadline'
   if reason and 'pid' in remote:
    pid=remote['pid'];cmd='args=$(tr "\\0" " " < /proc/'+pid+'/cmdline) || exit 2; case "$args" in *'+marker+'*) kill -TERM '+pid+';; *) exit 3;; esac'
    stopped=subprocess.run(base.runtime.PREFIX+['bash','-c',cmd],capture_output=True,text=True,timeout=10);(ROOT/'local-copy-stop.json').write_text(json.dumps({'reason':reason,'exit_code':stopped.returncode},indent=2)+'\n');break
   time.sleep(15)
  result=future.result(timeout=615)
 hashes={parts[1]:parts[0] for line in result['stdout'].splitlines() if len(parts:=line.split())==2 and re.fullmatch('[a-f0-9]{64}',parts[0])}
 result.update(expected_sha256=expected,verified=result['exit_code']==0 and all(hashes.get(n)==h for n,h in expected.items()),at=datetime.datetime.now(datetime.timezone.utc).isoformat())
 (ROOT/'local-copy-result.json').write_text(json.dumps(result,indent=2)+'\n');print('LOCAL_COPY_VERIFIED',result['verified'],flush=True)
if __name__=='__main__':main()
