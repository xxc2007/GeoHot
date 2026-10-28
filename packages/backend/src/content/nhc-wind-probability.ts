import { isNhcProseBulletin } from "./body-quality.ts";

/** Translate the fixed public NHC probability-product labels; keep the observation/data grid literal. */
export function translateNhcWindProbability(url: string, text: string): string | null {
  if (!isNhcProseBulletin(url,text) || !text.includes("WIND SPEED PROBABILITY TABLE FOR SPECIFIC LOCATIONS")
      || !text.includes("PROBABILITIES ARE GIVEN IN PERCENT") || !text.includes("FORECAST HOUR")) return null;
  const boundary = /- - - - WIND SPEED PROBABILITIES FOR SELECTED LOCATIONS - - - -/;
  if (!boundary.test(text)) return null;
  const replacements: Array<[RegExp,string]> = [
    [/NWS NATIONAL HURRICANE CENTER MIAMI FL/g,"美国国家气象局国家飓风中心，佛罗里达州迈阿密"],
    [/\b(TROPICAL STORM|HURRICANE|TROPICAL DEPRESSION) ([A-Z -]+) WIND SPEED PROBABILITIES NUMBER/g,"$1 $2 风速概率 第"],
    [/TROPICAL STORM/g,"热带风暴"], [/TROPICAL DEPRESSION/g,"热带低压"], [/HURRICANE/g,"飓风"],
    [/AT (\d+)Z THE CENTER OF/g,"在 $1Z，"],
    [/WAS LOCATED NEAR\s+LATITUDE (\d+(?:\.\d+)?) NORTH\.\.\.LONGITUDE (\d+(?:\.\d+)?) WEST WITH MAXIMUM SUSTAINED\s+WINDS NEAR/g,"的中心位于北纬 $1、西经 $2，最大持续风速接近"],
    [/WAS LOCATED NEAR\s+LATITUDE/g,"的中心位于纬度"], [/NORTH\.\.\.LONGITUDE/g,"北纬……经度"],
    [/WEST WITH MAXIMUM SUSTAINED\s+WINDS NEAR/g,"西经，最大持续风速接近"],
    [/Z INDICATES COORDINATED UNIVERSAL TIME \(GREENWICH\)/g,"Z 表示协调世界时（格林尼治时间）"],
    [/PACIFIC\s+DAYLIGHT TIME \(PDT\)\.\.\.SUBTRACT (\d+) HOURS FROM Z TIME/g,"太平洋夏令时（PDT）：Z 时减去 $1 小时"],
    [/HAWAIIAN STANDARD TIME \(HST\)\.\.\.SUBTRACT (\d+) HOURS FROM Z TIME/g,"夏威夷标准时（HST）：Z 时减去 $1 小时"],
    [/WIND SPEED PROBABILITY TABLE FOR SPECIFIC LOCATIONS/g,"特定地点的风速概率表"],
    [/CHANCES OF SUSTAINED \((\d+)-MINUTE AVERAGE\) WIND SPEEDS OF AT LEAST/g,"持续风速（$1 分钟平均值）至少达到以下阈值的概率"],
    [/FOR LOCATIONS AND TIME PERIODS DURING THE NEXT (\d+) DAYS/g,"适用于未来 $1 天内各地点和时段"],
    [/PROBABILITIES FOR LOCATIONS ARE GIVEN AS OP\(CP\) WHERE/g,"各地点概率以 OP(CP) 表示，其中"],
    [/OP\s+IS THE PROBABILITY OF THE EVENT BEGINNING DURING\s+AN INDIVIDUAL TIME PERIOD \(ONSET PROBABILITY\)/g,"OP 为事件在单个时段内开始发生的概率（起始概率）"],
    [/\(CP\) IS THE PROBABILITY OF THE EVENT OCCURRING BETWEEN/g,"(CP) 为事件发生于以下起止时刻之间的概率："],
    [/AND THE FORECAST HOUR \(CUMULATIVE PROBABILITY\)/g,"至相应预报时效（累计概率）"],
    [/PROBABILITIES ARE GIVEN IN PERCENT/g,"概率以百分比表示"],
    [/X INDICATES PROBABILITIES LESS THAN (\d+) PERCENT/g,"X 表示概率小于 $1%"],
    [/PROBABILITIES FOR (\d+) KT AND (\d+) KT ARE SHOWN AT A GIVEN\s+LOCATION WHEN\s+THE (\d+)-DAY CUMULATIVE PROBABILITY IS AT LEAST\s+(\d+) PERCENT\./g,"$1 KT 和 $2 KT 风速的概率显示条件：该地点 $3 天累计概率至少为 $4%。"],
    [/PROBABILITIES FOR (\d+)\.\.\.(\d+)\.\.\.(\d+) KT SHOWN WHEN THE (\d+)-DAY\s+(\d+)-KT CUMULATIVE PROBABILITY IS AT LEAST (\d+) PERCENT\./g,"风速 $1、$2、$3 KT 的概率仅在 $4 天内 $5 KT 风速的累计概率至少为 $6% 时显示。"],
    [boundary,"- - - - 指定地点的风速概率（下表代号、坐标及数值保留原样）- - - -"],
    [/FORECAST HOUR/g,"预报时效（小时）"], [/LOCATION KT/g,"地点   KT"], [/FORECASTER/g,"预报员"],
  ];
  let translated=text;
  for(const [pattern,replacement] of replacements) translated=translated.replace(pattern,replacement);
  // No generated facts: a template change that alters even one numeric token takes the normal path.
  if (JSON.stringify(text.match(/\d+(?:\.\d+)?/g))!==JSON.stringify(translated.match(/\d+(?:\.\d+)?/g))) return null;
  return translated;
}
