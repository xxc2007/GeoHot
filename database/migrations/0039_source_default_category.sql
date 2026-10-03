-- A source may declare which section its items belong to when nothing else says. The value is a taxonomy
-- key (industry/taxonomy.ts); seed and the admin path validate it, and publish ignores it when it is
-- unknown, so a stale key can never write a category no page knows. An explicit judgement (model answer
-- or a human override in editorial_overrides) always wins over it.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS default_category text;
