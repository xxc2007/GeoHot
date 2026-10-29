import { parseArgs } from "node:util";
import { repairReportWorkflow } from "../packages/backend/src/reports/repair.ts";
import { closeDb } from "../packages/backend/src/db.ts";
const {values}=parseArgs({options:{kind:{type:"string"},key:{type:"string"}}});
if ((values.kind || values.key) && (!values.key || !["daily","weekly","monthly"].includes(values.kind??""))) throw Error("Specify both --kind daily|weekly|monthly and --key");
try { console.log(JSON.stringify(await repairReportWorkflow(values.kind ? {kind:values.kind as "daily"|"weekly"|"monthly",key:values.key!}:undefined))); }
finally { await closeDb(); }
