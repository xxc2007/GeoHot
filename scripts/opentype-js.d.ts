// opentype.js 不带类型声明。`scripts/nameplates.ts` 用到的就是这些成员，只声明这些。
declare module "opentype.js" {
  export interface Path {
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
    toPathData(digits?: number): string;
  }
  export interface Font {
    getPath(text: string, x: number, y: number, fontSize: number): Path;
  }
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
