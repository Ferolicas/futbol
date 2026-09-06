BEGIN;
CREATE TABLE IF NOT EXISTS free_app_visits (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL,
  visit_number integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, visit_id),
  UNIQUE (user_id, visit_number)
);
CREATE TABLE IF NOT EXISTS email_campaign_deliveries (
  campaign text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  provider_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign, user_id)
);
COMMIT;
-- Rollback: deploy previous application first, then archive these additive
-- tables. Neither existing profiles nor subscriptions are changed.
