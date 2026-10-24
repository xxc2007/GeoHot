// Pure fail-closed policy. No service, process, network or filesystem actions.
export function decide(s) {
  const result = (reason, gateway = false, task = false, token = null) => ({ reason, startGateway: gateway, startTask: task, token });
  if (s.disabled || s.operatorStop) return result('operator_disabled');
  if (!s.inspectionOk) return result('inspection_failed');
  const gateway = !s.listenerPresent && !s.samePathProcess && s.exeExists;
  if (s.taskState === 'Running') return result('task_running', gateway);
  if (s.ownerLock) return result('owner_lock_requires_operator_review', gateway);
  if (s.taskState !== 'Ready') return result('task_not_ready', gateway);
  if (!s.listenerPresent) return result('gateway_not_listening', gateway);
  // A stored malformed/terminal/unknown record is never equivalent to first use.
  const old = s.lastState;
  let token;
  if (s.lastStateAbsent === true && s.lastTaskResult === 267011) token = 'first_never_run';
  else if (old && old.state === 'stopped' && old.finalReason === 'deadline' &&
      old.lockRetained === false && s.lastTaskResult === 0 &&
      Number.isFinite(old.at) && Number.isFinite(old.deadline) &&
      old.at >= old.deadline && s.now >= old.deadline) token = `deadline:${old.at}:${old.deadline}`;
  else return result('terminal_or_unclassified_requires_operator_review', gateway);
  if (s.consumedToken === token) return result('recovery_already_attempted', gateway);
  return result('eligible_recovery', gateway, true, token);
}
if (process.argv.includes('--stdin')) {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { process.stdout.write(JSON.stringify(decide(JSON.parse(data)))); }
  catch { process.stdout.write(JSON.stringify({ reason: 'invalid_snapshot', startGateway: false, startTask: false, token: null })); process.exitCode = 1; }
}
