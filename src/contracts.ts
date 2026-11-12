export interface ToolCall { id: string; name: string; arguments: unknown }
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown>; effect: 'read' | 'write' }
export interface ModelReply { stop: 'final' | 'tools' | 'length'; text: string; calls: ToolCall[] }
export interface Model { name: string; respond(messages: Message[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> }
export interface ContextProjection { messages: Message[]; estimatedTokens: number; omittedMessages: number; tokenCounter: string; limit: number }
export type RunStatus = 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_RECONCILIATION' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type Scenario = 'clean' | 'lost-receipt' | 'no-lookup';
export interface Run { id: string; workflowId?: string; parkedExecutionId?: string; goal: string; revision: number; status: RunStatus; model: string; scenario: Scenario; turns: number; maxTurns: number; deadline: string; messages: Message[]; pending: ToolCall[]; final: string | null; error: string | null; context: ContextProjection | null; createdAt: string; updatedAt: string }
export interface Operation { id: string; runId: string; revision: number; callId: string; tool: string; args: unknown; argsHash: string; state: 'PROPOSED' | 'APPROVED' | 'IN_FLIGHT' | 'CONFIRMED' | 'UNKNOWN' | 'ABANDONED'; result: unknown; attempts: number; approvedUntil: string | null; createdAt: string }
export interface RunEvent { id: number; runId: string; revision: number; type: string; detail: Record<string, unknown>; createdAt: string }
export interface RunDetail { execution?: {status: string; executorId?: string} | null; run: Run; operations: Operation[]; events: RunEvent[]; reports: Array<{operationId: string; report: string; revision: number}> }
export interface Command { commandId: string; expectedRevision: number; kind: 'approve' | 'revise' | 'cancel' | 'reconcile' | 'retry'; operationId?: string; goal?: string; resolution?: 'not_applied' | 'applied'; note?: string }
