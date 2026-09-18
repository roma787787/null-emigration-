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
    id                SERIAL PRIMARY KEY,
    token_id          INTEGER NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
    network           TEXT NOT NULL,
    contract_address  TEXT NOT NULL,
    creator_address   TEXT NOT NULL,
    token_b_address   TEXT,
    confidence        TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
    matched_functions TEXT[] NOT NULL DEFAULT '{}',
    tx_hash           TEXT NOT NULL,
    block_number      BIGINT NOT NULL,
    detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, contract_address)
);

CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id           TEXT PRIMARY KEY,
    confidence_filter TEXT NOT NULL DEFAULT 'ALL' CHECK (confidence_filter IN ('ALL', 'HIGH_ONLY')),
    networks_filter   TEXT[],
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
