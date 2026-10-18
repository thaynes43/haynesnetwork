"""One instrumented localhost load-only request; no pull, global changes or retry."""
import concurrent.futures,datetime,http.client,json,re,subprocess,threading,time
from pathlib import Path
import run_text as base
ROOT=Path(__file__).resolve().parent


def stats(resource):
 return {p[0]:int(p[1]) for line in resource['extra'].splitlines() if len(p:=line.split())==2 and p[1].isdigit()}


def idle(resource):
 v=base.values(resource);s=stats(resource)
 required=('active_file','inactive_file','file_dirty','file_writeback','unevictable','anon','kernel')
 if any(k not in s for k in required):return False
 clean=s['file_dirty']==s['file_writeback']==s['unevictable']==0
 noncache=v['cgroup_current']-s['inactive_file']-s['active_file']
 return (clean and noncache<=8*2**30 and v['host_available']>=64*2**30 and v['gpu_free_mib']>=23000 and
         v['oom']==v['oom_kill']==0 and not resource['snapshot']['compute_processes'] and
         resource['snapshot']['compute_query_exit']==resource['snapshot']['exit_code']==resource['extra_exit']==0)


def ownership(text,compute,core):
 own={pid for pid,args in re.findall(r'LOADER (\d+)\n([^\n]+)',text) if core in args}
 gpu={line.split(',')[1].strip() for line in compute.splitlines() if line.startswith('GPU-') and len(line.split(','))>=2}
 return own,gpu


def monitored_startup(model,body,folder,deadline):
 folder.mkdir(exist_ok=False)
 assert body['prompt']=='' and body['options']['num_thread']==2
 timeout=min(1200,int((deadline-datetime.datetime.now(datetime.timezone.utc)).total_seconds())-5)
 assert timeout>=60
 marker='media-repair-p2-'+model.split(':')[0]
 remote={};ready=threading.Event()
 rawbody=json.dumps(body,separators=(',',':')).encode()
 script=("printf 'CLIENT_PID=%s\\n' \"$$\" >&2; body=$(cat); exec 3<>/dev/tcp/127.0.0.1/11434; "
 "printf '%s\\r\\n' 'POST /api/generate HTTP/1.1' 'Host: localhost' 'Content-Type: application/json' 'Connection: close' "
 "'Content-Length: "+str(len(rawbody))+"' '' >&3; printf '%s' \"$body\" >&3; "
 "trap 'kill \"$reader\" 2>/dev/null; exit 143' TERM INT; cat <&3 & reader=$!; wait \"$reader\"")
 def call():
  start=time.monotonic()
  process=subprocess.Popen(base.runtime.PREFIX[:4]+['-i']+base.runtime.PREFIX[4:]+['timeout',str(timeout),'bash','-c',script,marker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  first=process.stderr.readline().decode(errors='replace');m=re.fullmatch(r'CLIENT_PID=(\d+)\n',first)
  if m:remote['pid']=m[1]
  ready.set()
  stdout,stderr=process.communicate(rawbody,timeout=timeout+10)
  receipt={'wall_seconds':time.monotonic()-start,'exit_code':process.returncode,'stderr':first+stderr.decode(errors='replace'),'startup_timeout_seconds':timeout}
  response=None
  if process.returncode:receipt['partial_http']=stdout.decode(errors='replace')
  else:
   http=http.client.HTTPResponse(base.runtime.SocketBytes(stdout));http.begin();raw=http.read().decode();receipt.update(http_status=http.status,raw_body=raw)
   try:response=json.loads(raw)
   except ValueError:pass
  return response,receipt
 def cancel(reason):
  if 'pid' not in remote:return {'reason':reason,'cancel':'unknown_client_pid_no_process_kill'}
  pid=remote['pid'];assert pid.isdigit()
  # Verify our unique marker before signaling only the experiment's HTTP reader.
  command='args=$(tr "\\0" " " < /proc/'+pid+'/cmdline 2>/dev/null) || exit 2; case "$args" in *'+marker+'*) kill -TERM '+pid+';; *) exit 3;; esac'
  r=subprocess.run(base.runtime.PREFIX+['bash','-c',command],capture_output=True,text=True,timeout=10)
  return {'reason':reason,'cancel_exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 manifest=json.loads((folder.parent/'registry-manifest.json').read_text())
 core=next(l['digest'].replace(':','-') for l in manifest['layers'] if l['mediaType']=='application/vnd.ollama.image.model')
 baseline=base.resources();last_io=None;last_progress=time.monotonic();pressure_streak=0;count=0
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  future=executor.submit(call);ready.wait(10)
  while not future.done():
   resource=base.resources()
   probe=subprocess.run(base.runtime.PREFIX[:4]+['-i']+base.runtime.PREFIX[4:]+['bash','-s'],input=(ROOT/'io_probe.sh').read_bytes(),capture_output=True,timeout=15)
   text=probe.stdout.decode(errors='replace');v=base.values(resource)
   progress=sum(int(n) for n in re.findall(r'^(?:read_bytes|rchar):\s*(\d+)',text,re.M))
   if last_io is None or progress>last_io:last_progress=time.monotonic()
   last_io=progress
   full=re.search(r'^full avg10=([\d.]+)',text,re.M);harmful=full is not None and float(full[1])>10
   pressure_streak=pressure_streak+1 if harmful else 0
   ps,pr=base.runtime.api('/api/ps')
   snap={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'resources':resource,'values':v,'probe_exit':probe.returncode,'probe':text,'resident':ps,'resident_receipt':pr,'io_progress_counter':progress,'seconds_since_io_progress':time.monotonic()-last_progress,'memory_full_pressure_streak':pressure_streak}
   (folder/('%03d.json'%count)).write_text(json.dumps(snap,indent=2)+'\n');count+=1
   print('P2_IO',model,count,'gpu',v['gpu_used_mib'],'noninactive',v['cgroup_noninactive'],'io',progress,flush=True)
   own,gpu_pids=ownership(text,resource['snapshot']['compute_processes'],core)
   reason=None
   if gpu_pids-own and not future.done():reason='Foreign_or_unknown_GPU_compute'
   elif not base.healthy(resource):reason='Unchanged_resource_or_OOM_gate'
   elif ps is None or any(m['name']!=model for m in ps['models']):reason='Foreign_or_unknown_resident'
   elif probe.returncode or 'inactive_file ' not in text or 'oom_kill ' not in text:reason='Probe_unavailable'
   elif pressure_streak>=2:reason='Persistent_memory_full_PSI_above10percent'
   elif time.monotonic()-last_progress>120:reason='No_measurable_loader_read_progress120seconds'
   elif datetime.datetime.now(datetime.timezone.utc)>=deadline:reason='Absolute_deadline'
   if reason:
    (folder/'cancel.json').write_text(json.dumps(cancel(reason),indent=2)+'\n');break
   time.sleep(15)
  return future.result(timeout=timeout+15)
