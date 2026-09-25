/**
 * Test helpers — build detached sessions with realistic message logs.
 * Uses the public `Session.create` API (no DSH runtime needed).
 */

import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** One message template: long enough to pass acp-kernel's 5000-char threshold. */
const LONG = 'Authentication uses JWT access tokens with 15 minute expiry and refresh tokens stored in Redis with 30 day TTL, implemented in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute. '.repeat(20)

export function longText(label: string, seed: number): string {
  return `${LONG} [${label} ${seed}]`
}

export function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

/**
 * Append the protected system head exactly the way the real agent loop does:
 * inside an open step, before that step's user messages. DSH 0.1.7 requires the
 * FIRST surface node to be a `system/message` append — any other surface event
 * ahead of it makes the stored log unreadable — so every fixture that models a
 * resumable session must open with this call.
 */
export function appendSystem(session: Session, text: string, turn = 1, step = 1): void {
  session.append('system/message', {
    turn,
    step,
    message: createSystemMessage(text),
  }, { surfaceOp: 'append' })
}

export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

export function appendAssistant(session: Session, text: string, turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

export function appendToolCall(session: Session, text: string, callId: string, turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  // A real session advertises every call before its result; the stored-log reader
  // rejects a tool/result whose call was never advertised.
  session.append('tool/call', { turn, step, callId, name: 'bash', arguments: '{"command":"ls"}' })
}

export function appendToolResult(session: Session, text: string, callId: string, turn = 1, step = 1): void {
  session.append('tool/result', {
    turn,
    step,
    // DSH 0.1.7 gives the tool result its own role and carries the answered call
    // id on the message rather than only inside the content block.
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append' })
}

/**
 * An assistant message carrying MULTIPLE tool-call blocks in one content list —
 * the real DSH shape whose projection yields `${seq}#${callId}` CoreMessage
 * ids (no bare `${seq}` ref, so it can never be a compress range edge).
 */
export function appendMultiToolCall(session: Session, text: string, callIds: readonly string[], turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        ...callIds.map((id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"ls"}' })),
      ],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  for (const id of callIds) session.append('tool/call', { turn, step, callId: id, name: 'bash', arguments: '{"command":"ls"}' })
}

/** A session with `count` alternating user/assistant text messages inside one open turn. */
export function buildTextSession(count: number): Session {
  const session = Session.create('test-session')
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('msg', index))
    else appendAssistant(session, longText('reply', index), 1, index)
  }
  return session
}
