ALTER TABLE organizations ALTER COLUMN retention_days SET DEFAULT 7;
UPDATE organizations SET retention_days = 7 WHERE retention_days IS NULL;
