# GEOHOT宣传片

使用 Video Shotcraft，自主创作；用户授权日期 2026-10-08。参考南昌十五中纪念册宣传片的纸白底色、真实页面首屏镜头、功能段和收尾组装，以及其 README 与独立播放器设计。

## 输出

1920×1080，30fps，1062 帧，35.4 秒；H.264 + AAC。另有 1080p 轻量版供 GitHub 原生视频预览。

- [完整成片](./geohot-promo.mp4)
- [无 BGM 版，保留音效](./geohot-promo-nobgm.mp4)
- [可重渲工程](./shotcraft-source.zip)：解压后进入 geohot，执行 npm ci，再 npm run render。Windows 字体与浏览器配置见 remotion.config.ts；更换系统时修改浏览器路径。
- [分镜与视觉基准](./DESIGN.md)
- [输出检查](./QA.json)

## 页面与数据

个人站使用公开文案、头像、公开联系邮箱；GEOHOT 只录制公开读者页面，资讯冻结于 2026-10-08。未访问后台、评论或内部用户数据。画面来自真实网站截图，不重绘产品界面。新闻截图展示产品能力，不代表观看时的最新资讯。

## 音乐与音效来源

音乐 House Vibez / Lily J，来自 Mixkit；已按照真实打击乐起点对齐。下列为 Video Shotcraft 素材库记录的来源，授权与原素材各自保留，项目 MIT 许可不替代媒体素材许可。

| `swoosh-quick.mp3` | `sfx/transition/` | Mixkit SFX Free License | Fast small sweep transition · https://assets.mixkit.co/active_storage/sfx/166/166-preview.mp3 |
| `transition-snap.mp3` | `sfx/transition/` | Mixkit SFX Free License | Fast transitions swoosh · https://assets.mixkit.co/active_storage/sfx/3115/3115-preview.mp3 |
| `transition-soft.mp3` | `sfx/transition/` | Mixkit SFX Free License | Air zoom vacuum · https://assets.mixkit.co/active_storage/sfx/2608/2608-preview.mp3 |
| `whoosh-fast.mp3` | `sfx/transition/` | Mixkit SFX Free License | Fast whoosh transition · https://assets.mixkit.co/active_storage/sfx/1490/1490-preview.mp3 |
| `impact-deep-whoosh.mp3` | `sfx/impact/` | Cinematic whoosh deep impact | https://assets.mixkit.co/active_storage/sfx/1143/1143-preview.mp3 |
| `sparkle-touch.mp3` | `sfx/light/` | Magic sparkle touch | https://assets.mixkit.co/active_storage/sfx/3083/3083-preview.mp3 |
| `marker-pen-line.mp3` | `sfx/text/` | Pen marker line | https://assets.mixkit.co/active_storage/sfx/2998/2998-preview.mp3 |
| `typewriter-hit-hard.mp3` | `sfx/text/` | Hard typewriter hit | https://assets.mixkit.co/active_storage/sfx/1364/1364-preview.mp3 |
| `typewriter-hit-soft.mp3` | `sfx/text/` | Typewriter soft hit | https://assets.mixkit.co/active_storage/sfx/1366/1366-preview.mp3 |
| `house-vibez.mp3` | House Vibez | Lily J | House | ~123 | https://assets.mixkit.co/music/745/745.mp3 |

结尾 riser-cine.mp3 为本项目重新生成：将来源明确的 Mixkit Cinematic whoosh deep impact（1143）反向、裁切为 44 帧并淡入，升至第 56 帧 impact 钉点，用作上升音效；最终 WAV 使用与源码同一 SHOTS/SFX 时间线，经 FFmpeg 按样本延迟、同一增益与淡入淡出混音。画面用 Remotion 渲染，两版复制同一 H.264 视频流。没有使用素材库同名但无法反查来源的原文件。

[Mixkit 音乐许可](https://mixkit.co/license/#musicFree) · [Mixkit 音效许可](https://mixkit.co/license/#sfxFree)

## 编辑

src/workbench.ts 暴露七镜头、字幕、强调色、SFX 和音乐音量；源码是交付权威。工作台本机入口见交付消息。修改画面后应重新渲染两版视频并生成封面。
