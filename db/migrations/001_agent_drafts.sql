CREATE TABLE agent_drafts (
  draft_id VARCHAR(128) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NOT NULL,
  conversation_id VARCHAR(128) NULL,
  classification VARCHAR(64) NOT NULL,
  facts_json JSON NOT NULL,
  evidence_refs_json JSON NOT NULL,
  possible_causes_json JSON NOT NULL,
  missing_information_json JSON NOT NULL,
  unsupported_capabilities_json JSON NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (draft_id),
  UNIQUE KEY uk_agent_drafts_tenant_idempotency (tenant_id, idempotency_key),
  KEY idx_agent_drafts_message (tenant_id, message_id),
  KEY idx_agent_drafts_run (tenant_id, run_id)
);

CREATE TABLE draft_confirmations (
  confirmation_id VARCHAR(128) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (confirmation_id),
  UNIQUE KEY uk_confirmation_token_hash (token_hash),
  KEY idx_confirmation_lookup (tenant_id, actor_id, run_id, content_hash)
);
