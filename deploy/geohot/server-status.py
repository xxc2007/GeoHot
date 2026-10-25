#!/usr/bin/env python3
"""Small, credential-free server sample. No database reads or model requests."""
import datetime,json,os,pathlib,platform,re,shutil,subprocess,time
root=pathlib.Path('/run/geohot-server');root.mkdir(mode=0o750,exist_ok=True)
def read(p):
 try:return pathlib.Path(p).read_text()
 except OSError:return ''
mem={k:int(v)*1024 for k,v in re.findall(r'^(\w+):\s+(\d+) kB',read('/proc/meminfo'),re.M)}
cpu=list(map(int,read('/proc/stat').splitlines()[0].split()[1:]));total=sum(cpu);idle=cpu[3]+cpu[4]
old={}
try:old=json.loads(read(root/'previous.json'))
except (ValueError,OSError):pass
percent=round(100*(1-(idle-old.get('idle',idle))/max(1,total-old.get('total',total))),1) if old else None
(root/'previous.json').write_text(json.dumps({'idle':idle,'total':total}))
services=[]
names=['nginx','postgresql@17-main','artalk','geohot-api','geohot-web','geohot-worker','geohot-content-executor','geohot-magpie','geohot-archive']
try:
 text=subprocess.run(['systemctl','show',*[n+'.service' for n in names],'-p','Id','-p','ActiveState','-p','MemoryCurrent','-p','NRestarts'],capture_output=True,text=True,timeout=4).stdout
 for block in text.strip().split('\n\n'):
  d=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
  services.append({'name':d.get('Id','').removesuffix('.service'),'state':d.get('ActiveState','unknown'),'memory':int(d.get('MemoryCurrent','0')) if d.get('MemoryCurrent','0').isdigit() else 0,'restarts':int(d.get('NRestarts','0'))})
except subprocess.TimeoutExpired:pass
pressure={}
for key in ['cpu','memory','io']:
 m=re.search(r'^(?:full|some) avg10=([\d.]+)',read('/proc/pressure/'+key),re.M)
 pressure[key]=float(m[1]) if m else 0
disk=shutil.disk_usage('/')
osrelease=dict(line.split('=',1) for line in read('/etc/os-release').splitlines() if '=' in line)
versions={'Magpie':read('/var/lib/geohot-magpie/version.txt').strip() or '已安装','Magpie 更新检查':'每 24 小时，官方签名校验并保留回滚版本','模型网关':'仅监听 127.0.0.1:3426','Magpie 管理':'仅监听 127.0.0.1:3430，经后台登录访问','数据存储':'PostgreSQL · 单一生产账本','服务器采样':'每 20 秒 · 不读取密钥或完整环境变量'}
sample={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':platform.node(),'os':osrelease.get('PRETTY_NAME','Linux').strip('"'),'kernel':platform.release(),'cpus':os.cpu_count(),'cpuPercent':None if percent is None else max(0,min(100,percent)),'uptime':float(read('/proc/uptime').split()[0]),'load':list(os.getloadavg()),'memory':{'total':mem.get('MemTotal',0),'available':mem.get('MemAvailable',0),'swapTotal':mem.get('SwapTotal',0),'swapFree':mem.get('SwapFree',0)},'disk':{'total':disk.total,'free':disk.free},'pressure':pressure,'services':services,'ports':['3000 / web','3001 / api','3426 / Magpie','3430 / Magpie 管理'],'versions':versions}
tmp=root/'status.tmp';tmp.write_text(json.dumps(sample,ensure_ascii=False));tmp.chmod(0o640);os.replace(tmp,root/'status.json')
