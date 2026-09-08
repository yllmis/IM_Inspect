CREATE TABLE IF NOT EXISTS agent_sessions (
  tenant_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  state_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, session_id),
  INDEX idx_agent_sessions_expires_at (expires_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin;
