// ADR-044 / DESIGN-022 (PLAN-021) — a stub Open WebUI ADMIN API for the AI-usage sub-tab e2e + capture.
// Mirrors the *arr stubs: a scriptable HTTP server with canned, DETERMINISTIC chats + users that the
// `ai-usage-sync` mode polls (GET /api/v1/chats/all/db + /api/v1/users/) exactly as it polls the live
// instance. Requires the api-key bearer — a missing/wrong key answers 401 (the unauth-401 contract).
//
// The canned data (3 users, 5 chats, 4 assistant image files across 2 chats, 3 models) makes the AI tab
// render non-trivial counts + trends + the full-only per-user/model tables at admin, and the aggregate
// counts + "admins see more" note at limited.
import { createServer, type Server } from 'node:http';

/** The throwaway api key the stub OWUI accepts (never a real credential). */
export const STUB_OPENWEBUI_API_KEY = 'stub-owui-key';

const nowSec = Math.floor(Date.now() / 1000);
const daysAgoSec = (n: number): number => nowSec - n * 86_400;

/** One assistant turn with an optional generated image + usage. */
function assistant(model: string, image: boolean, durationNs: number, tokens: number) {
  return {
    role: 'assistant',
    model,
    content: 'ok',
    timestamp: daysAgoSec(1),
    ...(image ? { files: [{ type: 'image', url: '/api/v1/files/x/content' }] } : {}),
    usage: { total_tokens: tokens, total_duration: durationNs },
  };
}

function chat(
  id: string,
  userId: string,
  title: string,
  model: string,
  createdDaysAgo: number,
  images: number,
) {
  const messages: unknown[] = [{ role: 'user', content: 'hi', timestamp: daysAgoSec(createdDaysAgo) }];
  // One assistant turn per image (each carries a generated image) + one plain closing turn.
  for (let i = 0; i < images; i++) messages.push(assistant(model, true, 2_500_000_000, 120));
  messages.push(assistant(model, false, 5_000_000_000, 200));
  return {
    id,
    user_id: userId,
    title,
    created_at: daysAgoSec(createdDaysAgo),
    updated_at: daysAgoSec(createdDaysAgo),
    archived: false,
    chat: { models: [model], messages },
  };
}

const USERS = [
  { id: 'u-alice', name: 'Alice Nguyen', email: 'alice@example.test', role: 'admin' },
  { id: 'u-bob', name: 'Bob Rivera', email: 'bob@example.test', role: 'user' },
  { id: 'u-carol', name: 'Carol Diaz', email: 'carol@example.test', role: 'user' },
];

const CHATS = [
  chat('c-1', 'u-alice', 'Trip planning', 'llama3.3:latest', 2, 0),
  chat('c-2', 'u-alice', 'Logo ideas', 'llama3.3:latest', 1, 1),
  chat('c-3', 'u-bob', 'Concept art', 'gpt-oss:latest', 1, 3),
  chat('c-4', 'u-carol', 'Recipe help', 'gemma3:27b', 3, 0),
  chat('c-5', 'u-carol', 'Homework', 'gemma3:27b', 4, 0),
];

export interface StubOpenWebUiServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startStubOpenWebUi(): Promise<StubOpenWebUiServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // The admin api-key bearer is required (the unauth-401 contract).
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${STUB_OPENWEBUI_API_KEY}`) {
      return json(401, { detail: 'Not authenticated' });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/chats/all/db') {
      return json(200, CHATS);
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/users/') {
      return json(200, { users: USERS, total: USERS.length });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(200, { status: true });
    }
    return json(404, { detail: `stub-openwebui: no handler for ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-openwebui failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
