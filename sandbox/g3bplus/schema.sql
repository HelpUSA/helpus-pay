-- G3-B+ ONLY: disposable database schema; NEVER apply to a real customer database.
BEGIN;
CREATE TABLE IF NOT EXISTS g3lab_orders (
 tenant_id TEXT NOT NULL CHECK (tenant_id ~ '^tenant_[a-zA-Z0-9_]{1,56}$'),
 order_id TEXT NOT NULL CHECK (length(order_id) BETWEEN 8 AND 100),
 customer_phone TEXT NOT NULL,
 amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 10000),
 status TEXT NOT NULL CHECK (status IN ('WAITING_PAYMENT','PAID','CANCELLED','EXPIRED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 paid_at TIMESTAMPTZ,
 PRIMARY KEY(tenant_id,order_id)
);
CREATE TABLE IF NOT EXISTS g3lab_charges (
 txid TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 10000),
 status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','CANCELLED','EXPIRED')),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 paid_at TIMESTAMPTZ,
 UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES g3lab_orders(tenant_id,order_id)
);
CREATE INDEX IF NOT EXISTS g3lab_charges_tenant_status_idx ON g3lab_charges(tenant_id,status);
CREATE TABLE IF NOT EXISTS g3lab_keys (
 tenant_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 payload_sha256 CHAR(64) NOT NULL,
 txid TEXT NOT NULL REFERENCES g3lab_charges(txid),
 PRIMARY KEY(tenant_id,request_key)
);
CREATE TABLE IF NOT EXISTS g3lab_events (
 event_id TEXT PRIMARY KEY,
 payload_sha256 CHAR(64) NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('SUCCESS','REQUIRES_MANUAL_REVIEW','FAILED')),
 outcome JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS g3lab_outbox (
 id BIGSERIAL PRIMARY KEY,
 event_id TEXT NOT NULL UNIQUE REFERENCES g3lab_events(event_id),
 tenant_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 txid TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('CALLBACK','MANUAL_REVIEW')),
 payload JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_PROGRESS','DELIVERED','MANUAL_REVIEW')),
 attempts INT NOT NULL DEFAULT 0,
 claimed_at TIMESTAMPTZ,
 last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS g3lab_outbox_pending_idx ON g3lab_outbox(kind,status,id);
COMMIT;
