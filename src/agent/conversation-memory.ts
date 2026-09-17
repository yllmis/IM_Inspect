import { ContextBudget, resolveContextBudget } from "./context-budget";
import {
  AgentSessionState,
  AgentSessionStateSchema,
  ConversationEntry,
} from "./session-state";

export function recordConversationExchange(
  rawState: AgentSessionState,
  input: {
    userText: string;
    assistantText: string;
    now?: Date;
    budget?: Partial<ContextBudget>;
  },
): AgentSessionState {
  const state = AgentSessionStateSchema.parse(rawState);
  const budget = resolveContextBudget(input.budget);
  const now = input.now ?? new Date();
  const perEntryBudget = Math.min(
    budget.maxSingleMessageCharacters,
    Math.floor(budget.maxRecentConversationCharacters / 2),
  );
  const entries: ConversationEntry[] = [
    {
      role: "user",
      content: clipStart(input.userText.trim(), perEntryBudget),
      createdAt: now.toISOString(),
    },
    {
      role: "assistant",
      content: clipStart(input.assistantText.trim(), perEntryBudget),
      createdAt: now.toISOString(),
    },
  ];
  const recent = [...state.recentConversation, ...entries];
  const evicted: ConversationEntry[] = [];
  while (
    recent.length > 6 ||
    conversationCharacters(recent) > budget.maxRecentConversationCharacters
  ) {
    const removed = recent.shift();
    if (removed) evicted.push(removed);
  }

  const historySummary =
    evicted.length === 0
      ? state.historySummary
      : {
          text: clipEnd(
            [
              state.historySummary?.text,
              ...evicted.map(
                (entry) =>
                  `${entry.role === "user" ? "客服" : "Agent"}：${clipStart(entry.content, 160)}`,
              ),
            ]
              .filter(Boolean)
              .join("；"),
            budget.maxHistorySummaryCharacters,
          ),
          summarizedMessages:
            (state.historySummary?.summarizedMessages ?? 0) + evicted.length,
          updatedAt: now.toISOString(),
          contextOnly: true as const,
          evidenceEligible: false as const,
        };

  return AgentSessionStateSchema.parse({
    ...state,
    recentConversation: recent,
    historySummary,
  });
}

function conversationCharacters(entries: ConversationEntry[]): number {
  return entries.reduce((total, entry) => total + entry.content.length, 0);
}

function clipStart(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function clipEnd(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `…${value.slice(-(maximum - 1))}`;
}
