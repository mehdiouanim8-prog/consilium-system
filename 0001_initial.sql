-- Consilium System: PostgreSQL schema (Railway).
-- Timestamps are stored as ISO-8601 TEXT (UTC) to match the application code.

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 180),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  phone TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  reference_url TEXT NOT NULL DEFAULT '',
  applicant_type TEXT NOT NULL,
  industry_market TEXT NOT NULL DEFAULT '',
  objectives_json TEXT NOT NULL DEFAULT '[]',
  working_toward TEXT NOT NULL,
  additional_context TEXT NOT NULL DEFAULT '',
  ability_to_accept_change INTEGER NOT NULL CHECK (ability_to_accept_change BETWEEN 1 AND 10),
  appointment_date TEXT NOT NULL CHECK (length(appointment_date) = 10),
  appointment_start TEXT NOT NULL CHECK (length(appointment_start) = 5),
  appointment_end TEXT NOT NULL CHECK (length(appointment_end) = 5),
  appointment_timezone TEXT NOT NULL DEFAULT 'Africa/Casablanca',
  applicant_timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  admin_notes TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  email_notification_status TEXT NOT NULL DEFAULT 'PENDING',
  email_notification_error TEXT NOT NULL DEFAULT '',
  admin_email_status TEXT NOT NULL DEFAULT 'PENDING',
  applicant_email_status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_status_created
  ON applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_appointment_date
  ON applications(appointment_date, status, appointment_start);
CREATE INDEX IF NOT EXISTS idx_applications_email
  ON applications(email_normalized, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_active_exact_slot
  ON applications(appointment_date, appointment_start)
  WHERE status IN ('PENDING', 'ACCEPTED');

-- Enforces the daily limit (9) and interval overlap inside the database.
-- A per-date advisory lock serialises concurrent writers for the same day, so two
-- simultaneous requests can neither reserve overlapping intervals nor exceed the limit.
CREATE OR REPLACE FUNCTION applications_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('PENDING', 'ACCEPTED') THEN
    PERFORM pg_advisory_xact_lock(hashtext('consilium-day:' || NEW.appointment_date));

    IF (
      SELECT COUNT(*) FROM applications existing
      WHERE existing.appointment_date = NEW.appointment_date
        AND existing.status IN ('PENDING', 'ACCEPTED')
        AND existing.id <> NEW.id
    ) >= 9 THEN
      RAISE EXCEPTION 'DAILY_LIMIT_REACHED';
    END IF;

    IF EXISTS (
      SELECT 1 FROM applications existing
      WHERE existing.appointment_date = NEW.appointment_date
        AND existing.status IN ('PENDING', 'ACCEPTED')
        AND existing.id <> NEW.id
        AND existing.appointment_start < NEW.appointment_end
        AND existing.appointment_end > NEW.appointment_start
    ) THEN
      RAISE EXCEPTION 'APPOINTMENT_CONFLICT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS applications_guard_insert ON applications;
CREATE TRIGGER applications_guard_insert
  BEFORE INSERT ON applications
  FOR EACH ROW EXECUTE FUNCTION applications_guard();

DROP TRIGGER IF EXISTS applications_guard_update ON applications;
CREATE TRIGGER applications_guard_update
  BEFORE UPDATE OF status, appointment_date, appointment_start, appointment_end ON applications
  FOR EACH ROW EXECUTE FUNCTION applications_guard();

CREATE TABLE IF NOT EXISTS admin_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  rate_key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rate_key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON api_rate_limits(window_start);

CREATE TABLE IF NOT EXISTS email_notifications (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'APPLICATION_ADMIN',
    'APPLICATION_APPLICANT',
    'ACCEPTED_APPLICANT',
    'DECLINED_APPLICANT'
  )),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'SENT', 'DELIVERED', 'DELIVERY_DELAYED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (application_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_email_notifications_application
  ON email_notifications(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_notifications_provider
  ON email_notifications(provider_message_id);

CREATE TABLE IF NOT EXISTS resend_webhook_events (
  event_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resend_webhook_email
  ON resend_webhook_events(email_id, received_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT 'admin',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
