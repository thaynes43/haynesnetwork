"""Run via existing Bazarr pod stdin. Read-only source, 8MiB input quota/25s per op."""
import argparse,hashlib,http.server,json,os,re,socket,subprocess,sys,threading,time
p=argparse.ArgumentParser();p.add_argument('mode',choices=['stat','probe','decode','frame','audio','subtitle']);p.add_argument('path');p.add_argument('--at',type=float,default=0);p.add_argument('--stream',type=int,default=0);a=p.parse_args()
assert a.at>=0 and 0<=a.stream<128
st=os.stat(a.path)
if a.mode=='stat':
 with open(a.path,'rb') as f:
  head=f.read(min(1048576,st.st_size));f.seek(max(0,st.st_size-1048576));tail=f.read(1048576)
 print(json.dumps({'size':st.st_size,'mtime_ns':st.st_mtime_ns,'head_1m_sha256':hashlib.sha256(head).hexdigest(),'tail_1m_sha256':hashlib.sha256(tail).hexdigest(),'partial_fingerprint_only':True}));sys.exit()
quota=8388608;state={'bytes_read':0,'quota_exhausted':False,'requests':0};lock=threading.Lock()
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path!='/sample':self.send_error(404);return
  requested=self.headers.get('Range','bytes=0-');match=re.fullmatch(r'bytes=(\d+)-(\d*)',requested)
  if not match:self.send_error(416);return
  start=int(match[1]);end=min(int(match[2]) if match[2] else st.st_size-1,st.st_size-1)
  if start>end:self.send_error(416);return
  with lock:state['requests']+=1
  self.connection.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,32768)
  self.send_response(206);self.send_header('Accept-Ranges','bytes');self.send_header('Content-Range',f'bytes {start}-{end}/{st.st_size}');self.send_header('Content-Length',str(end-start+1));self.end_headers()
  try:
   with open(a.path,'rb') as f:
    f.seek(start);left=end-start+1
    while left:
     with lock:
      n=min(32768,left,quota-state['bytes_read'])
      if n<=0:state['quota_exhausted']=True;break
      chunk=f.read(n);state['bytes_read']+=len(chunk)
     if not chunk:break
     self.wfile.write(chunk);left-=len(chunk)
  except (BrokenPipeError,ConnectionResetError):pass
  self.close_connection=True
class Server(http.server.ThreadingHTTPServer):daemon_threads=True
server=Server(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)+'/sample'
base=['nice','-n','19'];common=['-threads','1','-probesize','5000000','-analyzeduration','2000000']
if a.mode=='probe':cmd=base+['ffprobe','-v','error']+common+['-show_entries','format=format_name,duration,size:stream=index,codec_name,codec_type,profile,pix_fmt,width,height,channels:stream_tags=language','-of','json',url]
else:
 cmd=base+['ffmpeg','-nostdin','-v','error']+common+['-ss',str(a.at),'-i',url,'-threads','1','-filter_threads','1']
 if a.mode=='decode':cmd+=['-t','4','-map','0:v:0','-map','0:a:0?','-sn','-dn','-f','null','-']
 elif a.mode=='frame':cmd+=['-map','0:v:0','-frames:v','1','-vf','scale=640:-1','-c:v','png','-f','image2pipe','pipe:1']
 elif a.mode=='audio':cmd+=['-t','4','-map','0:'+str(a.stream),'-vn','-ac','1','-ar','16000','-f','wav','pipe:1']
 else:cmd+=['-t','4','-map','0:'+str(a.stream),'-vn','-an','-f','srt','pipe:1']
start=time.monotonic()
try:
 r=subprocess.run(cmd,capture_output=True,timeout=25);result={'exit_code':r.returncode,'stdout_bytes':len(r.stdout),'stderr':r.stderr.decode(errors='replace')[:8000]};sys.stdout.buffer.write(r.stdout)
except subprocess.TimeoutExpired as e:result={'exit_code':'timeout','stdout_bytes':len(e.stdout or b''),'stderr':(e.stderr or b'').decode(errors='replace')[:8000]};sys.stdout.buffer.write(e.stdout or b'')
finally:
 server.shutdown();server.server_close()
result.update(state,wall_seconds=time.monotonic()-start,source_unchanged=(os.stat(a.path).st_size==st.st_size and os.stat(a.path).st_mtime_ns==st.st_mtime_ns),argv=cmd);print(json.dumps(result),file=sys.stderr)
