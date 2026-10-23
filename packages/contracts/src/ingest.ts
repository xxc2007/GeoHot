/** Item positions are relative to the submitted batch; quarantine is not acceptance. */
export interface IngestDisposition {
  created: number;
  revised: number;
  accepted: number[];
  quarantined: number[];
  rejected: number[];
}

/** Validate source review and material-identity quarantine separately, including mixed batches. */
export function classifyIngestResponse(value: unknown, status: number, total: number): IngestDisposition {
  const invalid = (): never => { throw new Error('Invalid ingest response'); };
  if (!Number.isSafeInteger(total) || total < 1 || total > 50 || !value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const a = value as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= total;
  if (a.ok !== true || !count(a.created) || !count(a.revised) || !Array.isArray(a.skipped)) return invalid();
  const index = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < total;
  const skipped: number[] = [];
  for (const row of a.skipped) {
    if (!row || typeof row !== 'object' || !index(row.index) || skipped.includes(row.index)) return invalid();
    skipped.push(row.index);
  }
  const quarantineCount = a.quarantined === undefined ? 0 : a.quarantined;
  if (!count(quarantineCount)) return invalid();
  const conflicts: number[] = [];
  if (a.identityConflicts !== undefined) {
    if (!Array.isArray(a.identityConflicts)) return invalid();
    for (const row of a.identityConflicts) {
      if (!row || typeof row !== 'object' || !index(row.index) || conflicts.includes(row.index)
        || !((Number.isSafeInteger(row.conflictId) && row.conflictId > 0) || (typeof row.conflictId === 'string' && /^[1-9]\d*$/.test(row.conflictId)))) return invalid();
      conflicts.push(row.index);
    }
  }
  const positions = Array.from({length:total},(_,i)=>i);
  if (status === 202 && a.sourceStatus === 'pending_review') {
    if (quarantineCount !== total || a.created || a.revised || skipped.length || conflicts.length) return invalid();
    return {created:0,revised:0,accepted:[],quarantined:positions,rejected:[]};
  }
  if (a.sourceStatus !== undefined || (status !== 200 && status !== 202)) return invalid();
  if (status === 200 && (quarantineCount || conflicts.length)) return invalid();
  if (status === 202 && (!quarantineCount || quarantineCount !== conflicts.length || conflicts.some(i=>!skipped.includes(i)))) return invalid();
  const accepted = positions.filter(i=>!skipped.includes(i));
  if (a.created + a.revised > accepted.length) return invalid();
  return {created:a.created,revised:a.revised,accepted,quarantined:conflicts,rejected:skipped.filter(i=>!conflicts.includes(i))};
}
