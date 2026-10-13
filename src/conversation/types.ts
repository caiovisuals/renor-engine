export interface ToolCallEdit {
  kind: "edit";
  filePath: string;
  oldString: string;
  newString: string;
}

export interface ToolCallWrite {
  kind: "write";
  filePath: string;
}

export interface ToolCallBash {
  kind: "bash";
  command: string;
}

export type ToolCall = ToolCallEdit | ToolCallWrite | ToolCallBash;

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCall[];
}

export interface ParsedConversation {
  sessionId: string;
  title: string;
  timeStart: string; // ISO 8601 timestamp
  project: string; // cwd from Stop hook
  turns: ConversationTurn[];
}
