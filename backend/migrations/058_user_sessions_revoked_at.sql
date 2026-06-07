-- Phase 14 follow-up (security review finding #1, critical).
--
-- SCIM deactivation removes a user's org_members row, which makes requireAuth's
-- per-request re-read 401 their *access* token immediately. But their 7-day
-- *refresh* token was still valid, and /auth/refresh -> resolveOrg() would
-- silently mint a NEW personal-org session for the deprovisioned user. That
-- means deactivation didn't fully revoke access (GovRAMP AC-2 / "revoke
-- immediately").
--
-- This adds a per-user session-revocation watermark. SCIM deactivate/delete
-- sets it to NOW(); /auth/refresh rejects any refresh token issued (iat) before
-- it. It's a general "kill all of this user's sessions" primitive — not
-- SCIM-specific — so it can back future admin "force sign-out" features too.
--
-- users has no RLS (the auth paths read it directly via pool.query), matching
-- the existing model; no policy is added here.

ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;
