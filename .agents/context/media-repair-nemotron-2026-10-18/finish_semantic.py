"""Accepted isolated same-version daemon; exact-copy prerequisite and owned cleanup."""
import datetime,json,os,subprocess,sys,time
from pathlib import Path
import run_text as base
from io_startup_local_fixed import idle
from local_api import api_local
ROOT=Path(__file__).resolve().parent
LOCAL='/tmp/media-repair-nemotron-1018-local'
DEADLINE=datetime.datetime.fromisoformat('2026-10-18T22:25:00+00:00')

def save(name,value):(ROOT/name).write_text(json.dumps(value,indent=2)+'\n')
def remaining():return (DEADLINE-datetime.datetime.now(datetime.timezone.utc)).total_seconds()
def main():
 while not (ROOT/'local-copy-result.json').exists() and remaining()>65:time.sleep(2)
 if not (ROOT/'local-copy-result.json').exists() or not json.loads((ROOT/'local-copy-result.json').read_text())['verified']:
  save('local-comparison-stop.json',{'reason':'Exact_local_copy_not_verified','at':datetime.datetime.now(datetime.timezone.utc).isoformat()});return
 samples=[]
 for _ in range(12):
  ps,receipt=base.runtime.api('/api/ps');resources=base.resources()
  samples.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ps':ps,'receipt':receipt,'resources':resources,'idle':idle(resources)})
  save('p4-prelaunch-settle.json',samples)
  if ps is not None and not ps['models'] and idle(resources):break
  assert ps is not None and not ps['models'] and base.healthy(resources) and not resources['snapshot']['compute_processes'], 'Unsafe/foreign prerequisite; no settling through unsafe state'
  time.sleep(5)
 assert ps is not None and not ps['models'] and idle(resources), 'No overlap/foreign/resource prerequisite'
 # Give ordinary writeback time to settle; never sync/drop caches or alter a gate.
 check=subprocess.run(base.runtime.PREFIX+['bash','-c',f'set -e; test -d {LOCAL}; test "$(stat -c %a {LOCAL})" = 700; if (exec 3<>/dev/tcp/127.0.0.1/11435) 2>/dev/null; then exit 4; fi; df -B1 -T {LOCAL}'],capture_output=True,text=True,timeout=10)
 assert check.returncode==0
 seconds=int(remaining());assert seconds>65
 command=f'setsid timeout {seconds} env OLLAMA_MODELS={LOCAL}/models OLLAMA_HOST=127.0.0.1:11435 OLLAMA_NUM_PARALLEL=1 ollama serve > {LOCAL}/server.log 2>&1 < /dev/null & worker=$!; printf "%s\\n" "$worker"; sleep 1; cat /proc/$worker/stat; tr "\\0" " " < /proc/$worker/cmdline; printf "\\n"'
 launch=subprocess.run(base.runtime.PREFIX+['bash','-c',command],capture_output=True,text=True,timeout=10)
 assert launch.returncode==0
 lines=launch.stdout.splitlines();pid=lines[0].strip();assert pid.isdigit()
 fields=lines[1].split();assert fields[0]==pid and fields[4]==pid and LOCAL in launch.stdout and '127.0.0.1:11435' in launch.stdout
 save('p4-daemon-launch.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pid_pgid':pid,'launch_stdout':launch.stdout,'launch_stderr':launch.stderr,'deadline':DEADLINE.isoformat(),'physical_gpu_pod':'Same Prime3090/pod; process-only modelstore/host/parallel settings; original daemon not restarted/reconfigured.','capacity_port_owner':check.stdout})
 try:
  for _ in range(10):
   tags,receipt=api_local('/api/tags')
   if tags is not None:break
   time.sleep(1)
  assert tags is not None and len(tags['models'])==1 and tags['models'][0]['digest']=='d6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554'
  save('p4-daemon-tags.json',{'tags':tags,'receipt':receipt,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
  result=subprocess.run([sys.executable,'-u',str(ROOT/'run_p4.py')],stdout=open('/home/dev/.cache/media-repair-nemotron-1018/p4-run.log','w'),stderr=subprocess.STDOUT,timeout=max(1,int(remaining())))
  save('p4-driver-exit.json',{'exit_code':result.returncode,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 finally:
  # This endpoint belongs only to this isolated process. No foreign daemon unload.
  _,unload=api_local('/api/generate',{'model':'nemotron-3.5-bolt:74b-a9b','keep_alive':0})
  stop='args=$(tr "\\0" " " < /proc/'+pid+'/cmdline 2>/dev/null) || exit 0; group=$(awk \'{print $5}\' /proc/'+pid+'/stat); test "$group" = '+pid+' || exit 3; case "$args" in *'+LOCAL+'*127.0.0.1:11435*) kill -TERM -- -'+pid+';; *) exit 4;; esac'
  cleanup=subprocess.run(base.runtime.PREFIX+['bash','-c',stop],capture_output=True,text=True,timeout=10)
  log=subprocess.run(base.runtime.PREFIX+['tail','-n','100',LOCAL+'/server.log'],capture_output=True,timeout=10)
  save('p4-daemon-cleanup.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'unload':unload,'owned_group_exit':cleanup.returncode,'stdout':cleanup.stdout,'stderr':cleanup.stderr,'server_tail':log.stdout.decode(errors='replace'),'local_bytes':'Verified isolated copy retained under owned scratch; originals untouched.'})
if __name__=='__main__':main()
