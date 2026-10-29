-- A conservative initial request budget shared by all models on the one Raccoon account.
-- Not a statement of the upstream free allowance. Existing operator overrides are retained.
INSERT INTO budgets(service,per_minute,per_hour,per_day)
VALUES('raccoon',2,30,200),('codearts',2,30,200),
      ('minimax-code',2,30,200),('qoder-global',2,30,200)
ON CONFLICT(service) DO NOTHING;
