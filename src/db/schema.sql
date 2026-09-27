-- Multi-EVM migration tracker schema

CREATE TABLE IF NOT EXISTS tokens (
    id               SERIAL PRIMARY KEY,
    network          TEXT NOT NULL,
    address          TEXT NOT NULL,
    symbol           TEXT,
    name             TEXT,
    added_by_chat_id TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, address)
);

CREATE TABLE IF NOT EXISTS token_owners (
    id         SERIAL PRIMARY KEY,
    token_id   INTEGER NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('deployer', 'owner', 'admin', 'default_admin_role', 'manual')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token_id, address)
);

-- Fast lookup: "is this from-address, on this network, an owner we track?"
CREATE INDEX IF NOT EXISTS idx_token_owners_address ON token_owners (lower(address));

CREATE TABLE IF NOT EXISTS migration_contracts (
    id                 SERIAL PRIMARY KEY,
    token_id           INTEGER NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
    network            TEXT NOT NULL,
    contract_address   TEXT NOT NULL,
    creator_address    TEXT NOT NULL,
    token_b_address    TEXT,
    confidence         TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
    confidence_score   SMALLINT NOT NULL DEFAULT 0,
    matched_functions  TEXT[] NOT NULL DEFAULT '{}',
    matched_events     TEXT[] NOT NULL DEFAULT '{}',
    matched_auxiliary  TEXT[] NOT NULL DEFAULT '{}',
    token_b_source     TEXT,
    matched_getter     TEXT,
    tx_hash            TEXT NOT NULL,
    block_number       BIGINT NOT NULL,
    detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, contract_address)
);

-- Idempotent upgrades for deployments created before these columns existed
-- (CREATE TABLE IF NOT EXISTS above is a no-op once the table already exists).
ALTER TABLE migration_contracts ADD COLUMN IF NOT EXISTS confidence_score SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE migration_contracts ADD COLUMN IF NOT EXISTS matched_events TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE migration_contracts ADD COLUMN IF NOT EXISTS matched_auxiliary TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE migration_contracts ADD COLUMN IF NOT EXISTS token_b_source TEXT;
ALTER TABLE migration_contracts ADD COLUMN IF NOT EXISTS matched_getter TEXT;

CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id           TEXT PRIMARY KEY,
    confidence_filter TEXT NOT NULL DEFAULT 'ALL' CHECK (confidence_filter IN ('ALL', 'HIGH_ONLY')),
    networks_filter   TEXT[],
    -- NULL = the chat hasn't picked a language yet (shows the language picker).
    language          TEXT CHECK (language IN ('en', 'uk', 'ru')),
    approved          BOOLEAN NOT NULL DEFAULT false,
    -- Set once an admin approval request has been sent for this chat, so
    -- re-running /start or changing language doesn't spam admins again.
    access_requested  BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS language TEXT CHECK (language IN ('en', 'uk', 'ru'));
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS access_requested BOOLEAN NOT NULL DEFAULT false;

-- Last block each network's listener finished, so a restart (e.g. a redeploy)
-- resumes from there instead of skipping the blocks mined while it was down.
CREATE TABLE IF NOT EXISTS network_cursors (
    network    TEXT PRIMARY KEY,
    last_block BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
