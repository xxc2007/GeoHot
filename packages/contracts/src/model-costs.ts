export interface OfficialRate {
  id:string;name:string;currency:"USD"|"CNY";input:number;cached:number;output:number;
  currentInput:number;currentCached:number;currentOutput:number;source:string;verifiedOn:string;note:string;
}
export interface CostBounds {low:number;high:number}
export interface OfficialModelCost {
  service:string;model:string;name:string;currency:string|null;rateId:string|null;calls:number;pricedCalls:number;
  missingUsage:number;cacheUnknownCalls:number;list:CostBounds|null;current:CostBounds|null;reason?:string;
}
export interface OfficialCostReport {
  state:"ready"|"backfill";verifiedOn:string;policy:string;models:OfficialModelCost[];rates:OfficialRate[];
  totals:Array<{currency:string;list:CostBounds;current:CostBounds}>;
  calls:number;pricedCalls:number;missingUsage:number;unmappedCalls:number;cacheUnknownCalls:number;
}
