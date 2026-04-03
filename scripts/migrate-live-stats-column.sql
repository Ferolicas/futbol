-- Migration: add live_stats JSONB column to match_analysis
-- Stores corners, cards, goal scorers permanently so they survive Redis TTL expiry.
-- Run once in Supabase SQL Editor.

ALTER TABLE public.match_analysis
ADD COLUMN IF NOT EXISTS live_stats jsonb DEFAULT NULL;

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_match_analysis_live_stats
ON public.match_analysis (fixture_id)
WHERE live_stats IS NOT NULL;
