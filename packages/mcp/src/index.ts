// @hnet/mcp — the in-cluster MCP endpoint behind `POST /api/mcp` (ADR-087, DESIGN-049 D-02..D-06): consumer
// auth, the seven watch tools, the D-06 logging, and (tests) the Voice Budget. apps/web's route is a thin
// adapter over `handleMcpRequest`.
export { handleMcpRequest, readBodyCapped, MAX_MCP_BODY_BYTES, type McpRequestOptions } from './http';
export { authenticate, MCP_CONSUMERS, type McpConsumer, type WatchScope } from './auth';
export { WATCH_TOOLS, INSTRUCTIONS, SERVER_NAME, type WatchToolName } from './tools';
export { buildServer, runTool } from './server';
export { defaultDeps } from './deps';
export type { McpDeps } from './answers';
