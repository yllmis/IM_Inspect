import { EscalationDraftWorkflow } from "../application/escalation-draft-workflow";
import {
  createMySqlPool,
  readMySqlConnectionConfig,
} from "../persistence/mysql/connection";
import { MySqlEscalationDraftStore } from "../persistence/mysql/mysql-escalation-draft-store";
import { MySqlStateStore } from "../persistence/mysql/mysql-state-store";
import { EscalationDraftService } from "../tools/escalation-draft-service";

let workflow: EscalationDraftWorkflow | undefined;

/** 复用 MySQL 连接池；Route 不直接拼 SQL，也不直接消费确认令牌。 */
export function getEscalationDraftWorkflow(): EscalationDraftWorkflow {
  if (workflow) return workflow;
  const pool = createMySqlPool(readMySqlConnectionConfig());
  workflow = new EscalationDraftWorkflow(
    new MySqlStateStore(pool),
    new EscalationDraftService(new MySqlEscalationDraftStore(pool)),
  );
  return workflow;
}
