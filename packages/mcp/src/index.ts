// @hnet/mcp — the MCP endpoint behind the in-cluster `POST /api/mcp` (ADR-087, DESIGN-049 D-02..D-06) and the
// public `POST /mcp` (ADR-091, DESIGN-050 D-07): consumer auth (the hop bearer; a delegated OAuth token), the
// nine watch tools (ADR-092 added `watchlist` and `set_watchlist`), the D-06 logging, and (tests) the Voice Budget.
// apps/web's two routes are thin adapters over `handleMcpRequest` (the public one passes `authenticateOAuth`).
export {
  handleMcpRequest,
  outOfScopeTool,
  readBodyCapped,
  MAX_MCP_BODY_BYTES,
  MCP_DEADLINE_MS,
  type McpRequestOptions,
} from './http';
export {
  authenticate,
  MCP_CONSUMERS,
  type AuthResult,
  type HopConsumer,
  type McpConsumer,
  type WatchScope,
} from './auth';
export {
  authenticateOAuth,
  insufficientScopeChallenge,
  oauthChallenge,
  type OAuthAuthOptions,
} from './oauth';
export { WATCH_TOOLS, INSTRUCTIONS, SERVER_NAME, type WatchToolName } from './tools';
export { buildServer, resolvePrincipal, runTool } from './server';
export { defaultDeps } from './deps';
export type { McpDeps, WatchPrincipal } from './answers';
