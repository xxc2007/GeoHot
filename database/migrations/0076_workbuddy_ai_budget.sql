-- Restore the registered international channel on clean installs without changing live budgets.
-- Same conservative channel ceiling as the existing WorkBuddy service; no probe or quota increase.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('workbuddy-ai', 30, 600, 12000, 'WorkBuddy international channel; separate receipt ledger and existing account limits')
ON CONFLICT (service) DO NOTHING;
