/** Pool eligibility only. It neither retries a request nor changes the billing ledger. */
export function unhealthyModel(s: { attempts:number; answered:number; timeouts:number }, slowTimeoutGuard=false): boolean {
  if (![s.attempts,s.answered,s.timeouts].every(n=>Number.isSafeInteger(n)&&n>=0)) return false;
  return (s.attempts>=6 && s.answered*2<s.attempts) || (slowTimeoutGuard && s.timeouts>=2 && s.answered===0);
}
