// ADR-087 / DESIGN-049 D-02 / D-05 / D-06 — one MCP server per request (stateless: a server binds one
// transport, and a stateless transport refuses a second request), serving the consumer's tools. Every tool
// answers plain text (no `structuredContent`, no `outputSchema`); a thrown failure is replaced by the D-06
// text here, before the SDK could hand the raw `error.message` to the client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { formatNotReady, formatWatchError, selectWatchOwner } from '@hnet/watch';
import { z } from 'zod';
import {
  answerDismiss,
  answerMarkWatched,
  answerRecentHistory,
  answerRecommend,
  answerUndo,
  answerUnfinished,
  answerWatchStatus,
  type AnswerContext,
  type McpDeps,
} from './answers';
import type { McpConsumer } from './auth';
import {
  SLOW_CALL_MS,
  errorCode,
  revalidateTimeoutLine,
  slowCallLine,
  slowestPhase,
  toolCalledLine,
} from './log';
import { INSTRUCTIONS, SERVER_NAME, WATCH_TOOLS, type WatchToolDef, type WatchToolName } from './tools';
import { APP_VERSION } from './version';

type Answer = (ctx: AnswerContext, args: never) => Promise<string>;

const ANSWERS: Record<WatchToolName, Answer> = {
  unfinished: answerUnfinished as Answer,
  recommend: answerRecommend as Answer,
  watch_status: answerWatchStatus as Answer,
  recent_history: answerRecentHistory as Answer,
  mark_watched: answerMarkWatched as Answer,
  dismiss: answerDismiss as Answer,
  undo_last_change: answerUndo as Answer,
};

function text(t: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

/**
 * What the SDK validates a call against: anything. The STRICT zod schema of each tool validates inside
 * `runTool` instead, so an invalid call is answered — and logged (D-06: one line per call) — like any other.
 */
const ACCEPT_ANY = z.looseObject({});

/** A short, value-free summary of why arguments were refused (paths and zod messages only). */
function invalidArgs(tool: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
    .join('; ');
  return `Invalid arguments for ${tool}: ${issues}.`;
}

/** Run one tool call: principal, scope, answer, D-06 logging and error sanitizing. Never throws. */
export async function runTool(
  tool: WatchToolDef,
  args: unknown,
  deps: McpDeps,
  consumer: McpConsumer,
): Promise<CallToolResult> {
  const started = Date.now();
  const phases = {};
  const finish = (result: CallToolResult, code?: string): CallToolResult => {
    const ms = Date.now() - started;
    const chars = result.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
    deps.log(toolCalledLine({ tool: tool.name, consumer: consumer.name, ms, ok: !result.isError, chars, ...(code ? { code } : {}) }));
    if (ms > SLOW_CALL_MS) deps.log(slowCallLine({ tool: tool.name, consumer: consumer.name, ms, phase: slowestPhase(phases) }));
    return result;
  };
  try {
    if (!consumer.scopes.includes(tool.scope)) {
      return finish(text(`This connection can't use ${tool.name}.`, true), 'scope');
    }
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) return finish(text(invalidArgs(tool.name, parsed.error), true), 'invalid_args');
    // D-03: the principal is THE owner row; none yet ⇒ an ordinary answer, not an error.
    const owner = await selectWatchOwner(deps.db);
    if (!owner) return finish(text(formatNotReady()));
    const ctx: AnswerContext = { deps, owner, consumer, phases };
    const answer = await ANSWERS[tool.name as WatchToolName](ctx, parsed.data as never);
    if (ctx.revalidateTimedOut) deps.log(revalidateTimeoutLine({ tool: tool.name, consumer: consumer.name }));
    return finish(text(answer));
  } catch (error) {
    return finish(text(formatWatchError(), true), errorCode(error));
  }
}

/** The static `tools/list` entries per scope set — built once, from the hand-written schemas (D-05). */
const LISTS = new Map<string, Tool[]>();

export function toolList(consumer: McpConsumer): Tool[] {
  const id = [...consumer.scopes].sort().join(',');
  const cached = LISTS.get(id);
  if (cached) return cached;
  const list: Tool[] = (WATCH_TOOLS as readonly WatchToolDef[])
    .filter((t) => consumer.scopes.includes(t.scope))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
      annotations: t.annotations,
    }));
  LISTS.set(id, list);
  return list;
}

/**
 * A fresh server for one request, with the consumer's tools. Calls go through `registerTool` into `runTool`,
 * where the module-scope strict zod schema validates them; `tools/list` is served from the hand-written JSON
 * Schemas through the low-level handler (D-05: the SDK-generated list is over the Voice Budget).
 */
export function buildServer(deps: McpDeps, consumer: McpConsumer): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: APP_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  for (const tool of WATCH_TOOLS as readonly WatchToolDef[]) {
    if (!consumer.scopes.includes(tool.scope)) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: ACCEPT_ANY, annotations: tool.annotations },
      (args: unknown) => runTool(tool, args, deps, consumer),
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(consumer) }));
  return server;
}

