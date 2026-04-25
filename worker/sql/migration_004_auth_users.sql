-- Migration 004: extend `users` table for full auth.
--
-- The legacy table existed with (id, username, password_hash, salt, created_at)
-- but had no role / status / email / last_login fields. Adding them in-place;
-- existing rows (if any) default to role='admin', is_active=1.
--
-- Roles:
--   super_admin — only this role can create/delete other users
--   admin       — full read/write of report data, sites, operators
--   readonly    — read-only access to reports (future use)
--
-- Note: we keep `username` as the login identifier (UNIQUE), but populate
-- `email` separately so admin UIs can show contact info even when username
-- is something like "li_admin".

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN last_login INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
