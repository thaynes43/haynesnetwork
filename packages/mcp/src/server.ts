// ADR-087 / DESIGN-049 D-02 / D-05 / D-06 — one MCP server per request (stateless: a server binds one
// transport, and a stateless transport refuses a second request), serving the consumer's tools. Every tool
// answers plain text (no `structuredContent`, no `outputSchema`); a thrown failure is replaced by the D-06
// text here, before the SDK could hand the raw `error.message` to the client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  formatNotReady,
  formatNotSetUp,
  formatWatchError,
  selectWatchAccountForUser,
  selectWatchOwner,
} from '@hnet/watch';
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
  type WatchPrincipal,
} from './answers';
import { WatchNotReadyError } from '@hnet/domain';
import type { McpConsumer } from './auth';
import {
  SLOW_CALL_MS,
  errorCode,
  revalidateTimeoutLine,
  slowCallLine,
  slowestPhase,
  toolCalledLine,
} from './log';
import {
  INSTRUCTIONS,
  SERVER_NAME,
  WATCH_TOOLS,
  type WatchToolDef,
  type WatchToolName,
} from './tools';
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
  return isError
    ? { content: [{ type: 'text', text: t }], isError: true }
    : { content: [{ type: 'text', text: t }] };
}

/**
 * What the SDK validates a call against: anything, including no `arguments` at all (the key is optional in
 * MCP, and a bare `z.looseObject({})` refuses `undefined` before the tool runs). The STRICT zod schema of
 * each tool validates inside `runTool` instead (which reads a missing `arguments` as `{}`), so an invalid
 * call is answered — and logged (D-06: one line per call) — like any other.
 */
const ACCEPT_ANY = z.looseObject({}).optional();

/** A short, value-free summary of why arguments were refused (paths and zod messages only). */
function invalidArgs(tool: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
    .join('; ');
  return `Invalid arguments for ${tool}: ${issues}.`;
}

/**
 * Run one tool call: principal, scope, answer, D-06 logging and error sanitizing. Never throws.
 *
 * `signal` is the SDK's per-request abort signal: it fires when the per-request server closes — the D-02
 * deadline in `handleMcpRequest` — while the call is still running. The call is then finished at once (its
 * one `tool_called` line, `"code":"deadline"`; the HTTP layer answers the client), and whatever the
 * abandoned work does later is never logged: every line goes through `finish`, which runs once.
 */
export async function runTool(
  tool: WatchToolDef,
  args: unknown,
  deps: McpDeps,
  consumer: McpConsumer,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const started = Date.now();
  const phases = {};
  let finished = false;
  const onAbort = () => {
    finish(text(formatWatchError(), true), 'deadline');
  };
  const finish = (
    result: CallToolResult,
    code?: string,
    revalidateTimedOut = false,
  ): CallToolResult => {
    if (finished) return result;
    finished = true;
    signal?.removeEventListener('abort', onAbort);
    const ms = Date.now() - started;
    const chars = result.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
    if (revalidateTimedOut)
      deps.log(revalidateTimeoutLine({ tool: tool.name, consumer: consumer.name }));
    deps.log(
      toolCalledLine({
        tool: tool.name,
        consumer: consumer.name,
        ms,
        ok: !result.isError,
        chars,
        ...(code ? { code } : {}),
      }),
    );
    if (ms > SLOW_CALL_MS)
      deps.log(
        slowCallLine({ tool: tool.name, consumer: consumer.name, ms, phase: slowestPhase(phases) }),
      );
    return result;
  };
  if (signal?.aborted) return finish(text(formatWatchError(), true), 'deadline');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (!consumer.scopes.includes(tool.scope)) {
      return finish(text(`This connection can't use ${tool.name}.`, true), 'scope');
    }
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success)
      return finish(text(invalidArgs(tool.name, parsed.error), true), 'invalid_args');
    // The principal (an ordinary answer when there is none, never an error): the hop acts as THE owner row
    // (D-03; none yet ⇒ "not ready"); a delegated token acts as its user's own tracked account (ADR-091 C-04 /
    // DESIGN-050 D-07; unmapped or untracked ⇒ "isn't set up for your account yet").
    const account = await resolvePrincipal(deps, consumer);
    if (!account) return finish(text(notServed(consumer)));
    const ctx: AnswerContext = { deps, account, consumer, phases };
    const answer = await ANSWERS[tool.name as WatchToolName](ctx, parsed.data as never);
    return finish(text(answer), undefined, ctx.revalidateTimedOut === true);
  } catch (error) {
    // The domain refuses an account that is no longer tracked (or no longer the owner) between the read above
    // and the flow's own check — still the ordinary answer, never isError.
    if (error instanceof WatchNotReadyError) return finish(text(notServed(consumer)));
    return finish(text(formatWatchError(), true), errorCode(error));
  }
}

/**
 * The watch account a call acts for. The hop: THE `owner` row (D-03), attributed to the owner's linked app user.
 * A delegated token: `users.id` → the ADR-053 Plex Account Map → its `tracked` watch account (ADR-091 C-04),
 * attributed to the token's user.
 */
export async function resolvePrincipal(deps: McpDeps, consumer: McpConsumer): Promise<WatchPrincipal | null> {
  if (consumer.userId === undefined) {
    const owner = await selectWatchOwner(deps.db);
    return owner ? { ...owner, isOwner: true } : null;
  }
  const account = await selectWatchAccountForUser(deps.db, consumer.userId);
  if (!account) return null;
  return {
    plexAccountId: account.plexAccountId,
    username: account.username,
    appUserId: consumer.userId,
    isOwner: account.role === 'owner',
  };
}

/** The ordinary answer when the principal has no watch history to serve. */
function notServed(consumer: McpConsumer): string {
  return consumer.userId === undefined ? formatNotReady() : formatNotSetUp();
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
      (args, extra) => runTool(tool, args, deps, consumer, extra.signal),
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(consumer) }));
  return server;
}
