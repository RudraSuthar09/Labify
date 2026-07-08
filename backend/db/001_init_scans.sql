-- Migration 001 — the scans audit table.
--
-- HOW TO APPLY (Supabase):
--   1. Open Supabase → SQL Editor → New query
--   2. Paste this file's contents and run it
--   3. Confirm the `scans` table appears under Table Editor
--
-- The migration is idempotent (IF NOT EXISTS everywhere) so re-running is safe.

-- pgcrypto for gen_random_uuid(). Supabase projects have it available but not
-- always enabled by default; this is a no-op when already installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.scans (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- What was scanned + what the label said.
    decoded_barcode   TEXT        NOT NULL,
    expected_value    TEXT,                       -- null when OCR didn't find one
    label_type        TEXT        NOT NULL,

    -- Verdict.
    status            TEXT        NOT NULL
                       CHECK (status IN ('pass', 'fail', 'warning')),
    reason            TEXT        NOT NULL,

    -- Extracted structure. JSONB so field shape can evolve per label profile
    -- without another migration.
    extracted_fields  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    mismatches        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    missing_fields    JSONB       NOT NULL DEFAULT '[]'::jsonb,

    -- Raw OCR + storage pointer.
    ocr_text          TEXT        NOT NULL DEFAULT '',
    image_url         TEXT                          -- null when archive is off/failed
);

-- Primary browse ordering: newest first.
CREATE INDEX IF NOT EXISTS scans_created_at_desc_idx
    ON public.scans (created_at DESC, id DESC);

-- Filtered browse: /api/scans?status=fail — index-only scan on the composite.
CREATE INDEX IF NOT EXISTS scans_status_created_at_desc_idx
    ON public.scans (status, created_at DESC, id DESC);

-- Daily stats aggregation (GET /api/stats). date_trunc keeps the index usable
-- across timezones — we always aggregate in UTC on the server.
CREATE INDEX IF NOT EXISTS scans_created_at_date_idx
    ON public.scans ((date_trunc('day', created_at)));

COMMENT ON TABLE  public.scans IS 'One row per completed /api/verify — the audit log the mobile app browses.';
COMMENT ON COLUMN public.scans.extracted_fields IS 'name → value pairs the label profile pulled out of ocr_text';
COMMENT ON COLUMN public.scans.mismatches       IS 'Array of { field, expected, got } — differences the verifier flagged';
COMMENT ON COLUMN public.scans.missing_fields   IS 'Array of field names the profile required but OCR did not find';
