// Bounded stored-data warmup after migration0092. No model/image/network/provider calls.
import {recoverWorkflowReadiness} from '../packages/backend/src/operations/recover-workflow-readiness.ts';
import {closeDb} from '../packages/backend/src/db.ts';
const args=process.argv.slice(2);
const rounds=Number(args.find(a=>a.startsWith('--rounds='))?.slice(9)??1);
if(!Number.isInteger(rounds)||rounds<1||rounds>20)throw Error('--rounds must be 1..20');
try{
 for(let i=0;i<rounds;i++){
  const result=await recoverWorkflowReadiness({reportsOnly:args.includes('--reports'),selectedOnly:args.includes('--selected'),summaryOnly:args.includes('--summary'),limit:250,budgetMs:4000});
  console.log(JSON.stringify({round:i+1,...result}));
  if('held' in result || result.wrapped)break;
 }
}finally{await closeDb();}
