import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Recovery may only restart running processes. R115 and operator stops own their
// recovery decisions; unreadable telemetry and resource pressure are not a green light.
export function decision(s) {
  if (!s.active || s.gate || s.disarmed || ![s.heartbeat,s.age,s.available,s.load,s.swap,s.now,s.lastRestart].every(Number.isFinite)
      || s.heartbeat < 180 || s.age < 300 || s.available < 96
      || s.load > 3 || s.swap > 1400 || s.now - s.lastRestart < 600) return 'skip';
  return s.streak >= 1 ? 'restart' : 'suspect';
}

// A failed unit is different from an intentional inactive/operator stop. Recover
// start-limit exhaustion only with headroom, and bound this watchdog to once per ten minutes.
export function failedRecovery(s) {
  return s.failed && !s.gate && !s.disarmed
    && [s.available,s.load,s.swap,s.now,s.lastRestart].every(Number.isFinite)
    && s.available >= 96 && s.load <= 3 && s.swap <= 1400
    && s.now-s.lastRestart >= 600;
}

export function maintenanceBlocksRecovery(owner, role) {
  return role !== 'worker' || owner?.owner !== 'workstation-extraction'
    || typeof owner.session !== 'string' || !/^[a-f0-9]{32}$/.test(owner.session);
}

function ownerBlocksRecovery(role) {
  const file='/var/lib/geohot-maintenance/worker-owner.json';
  if(!existsSync(file)) return false;
  try { return maintenanceBlocksRecovery(JSON.parse(readFileSync(file,'utf8')),role); }
  catch { return true; }
}

function run() {
  const exec = (cmd, args) => execFileSync(cmd, args, {encoding:'utf8',timeout:8000}).trim();
  const stateDir='/run/geohot-liveness';
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const file=stateDir+'/state.json';
  let prior={};
  if(existsSync(file)) prior=JSON.parse(readFileSync(file,'utf8'));
  const memory=readFileSync('/proc/meminfo','utf8');
  const mb=(key)=>Number(new RegExp('^'+key+':\\s+(\\d+)','m').exec(memory)?.[1])/1024;
  const now=Math.floor(Date.now()/1000);
  const shared={gate:existsSync('/run/geohot-r115-gate'),disarmed:existsSync('/etc/geohot/r115-gate.disarmed'),
    available:mb('MemAvailable'),load:Number(readFileSync('/proc/loadavg','utf8').split(' ')[0]),
    swap:mb('SwapTotal')-mb('SwapFree'),now,lastRestart:prior.lastRestart??0};
  const state={lastRestart:prior.lastRestart??0};
  for(const role of ['worker','content-executor']) {
    const roleGate=shared.gate||ownerBlocksRecovery(role);
    const unit='geohot-'+role+'.service';
    const properties=Object.fromEntries(exec('systemctl',['show',unit,'-p','ActiveState','-p','MainPID','-p','ActiveEnterTimestampMonotonic'])
      .split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
    let heartbeat=null;
    if(properties.ActiveState==='active'&&!roleGate&&!shared.disarmed) {
      const raw=exec('sudo',['-n','-u','postgres','env','PGOPTIONS=-c statement_timeout=3000','psql','-X','-tA','-d','geohot','-c',
        `SELECT floor(extract(epoch FROM now()-updated_at)) FROM settings WHERE key='heartbeat.${role}'`]);
      if(/^\d+$/.test(raw)) heartbeat=Number(raw);
    }
    const age=Number(readFileSync('/proc/uptime','utf8').split(' ')[0])-Number(properties.ActiveEnterTimestampMonotonic)/1e6;
    const previous=prior[role];
    const snapshot={...shared,gate:roleGate,active:properties.ActiveState==='active',age,heartbeat,
      streak:previous?.pid===properties.MainPID&&now-(prior.at??0)<300?previous.streak:0};
    const failed=failedRecovery({...snapshot,failed:properties.ActiveState==='failed'});
    const action=failed?'restart':decision(snapshot);
    state[role]={pid:properties.MainPID,streak:action==='suspect'?1:0};
    if(action==='restart') {
      // Recheck protection immediately before submitting the restart transaction.
      if(existsSync('/run/geohot-r115-gate')||existsSync('/etc/geohot/r115-gate.disarmed')||ownerBlocksRecovery(role)) break;
      if(failed) {
        exec('systemctl',['reset-failed',unit]);
        exec('systemctl',['start','--no-block',unit]);
      } else exec('systemctl',['try-restart','--no-block',unit]);
      state.lastRestart=now;
      console.log(JSON.stringify({action:'restart-submitted',role,heartbeat,age}));
      break;
    }
    console.log(JSON.stringify({action,role,heartbeat,available:Math.round(shared.available),gate:roleGate}));
  }
  state.at=now;
  writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});
  renameSync(file+'.tmp',file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { run(); } catch(error) { console.error('liveness check failed; no recovery inferred:',error.message);process.exitCode=1; }
}
