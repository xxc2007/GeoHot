-- 两个还没被任何主题认领的机构标签：GDACS（近 30 天 180 条）与自然资源部（128 条）。
-- 2026-11-05 主题候选 triage（#183）之后，剩下的候选正是这两家：它们有稳定的实时来源，
-- 但 43 个主题里没有任何一个的 tags 认领过这两个名字，于是长期只能待在候选表里。
-- 补成正式主题（grp=company，排在既有 company 之后），给它们自己的分类页与计数。
INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position, keywords)
VALUES
  (
    'gdacs',
    'GDACS 全球灾害预警',
    'company',
    'gdacs',
    '{GDACS,灾害事件,预警/响应}',
    '欧盟委员会与联合国共同运行的全球灾害警报系统：地震、热带气旋、洪水与野火的自动速报和影响估计，是跨机构灾害事件的一手汇总。',
    '{disaster-events,earthquakes,tropical-cyclones}',
    43,
    '{}'
  ),
  (
    'mnr',
    '中国自然资源部',
    'company',
    'mnr',
    '{自然资源部,政策/规划,行政区划调整}',
    '自然资源部及其直属单位：国土空间规划、耕地保护、地质调查与海洋预报，国土空间用途管制和资源调查通报的官方出口。',
    '{policy-planning,administrative-divisions,soil-land}',
    44,
    '{}'
  )
ON CONFLICT (slug) DO NOTHING;