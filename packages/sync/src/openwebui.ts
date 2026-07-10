// ADR-044 / DESIGN-022 (PLAN-021) — the Open WebUI admin-API READ client + the raw-blob normalizer the
// `ai-usage-sync` mode uses. READ-ONLY by construction: only GETs OWUI's admin endpoints with the
// api-key bearer; it never mutates Open WebUI (CLAUDE.md rule 4 discipline for a non-*arr source).
//
// The two endpoints (verified against the running instance, OWUI 0.7.2):
//   • GET /api/v1/chats/all/db — every chat: { id, user_id, title, created_at, updated_at, archived,
//     chat:{ models:[…], messages:[{ role, model?, timestamp, content, files?:[{type,url}], usage? }] } }.
//     created_at/updated_at are epoch SECONDS.
//   • GET /api/v1/users/       — { users:[{ id, name, email, role, … }] } (admin list; used to attribute
//     each chat's user_id to a name/email/role — surfaced only at the `full`/admin metrics level).
//
// IMAGE-GENERATION HEURISTIC (documented): an image generation is an ASSISTANT-role message whose
// `files[]` carries an entry of `type === 'image'` (url `/api/v1/files/{id}/content`). We count one per
// such entry. Only assistant-role messages are counted, so a user IMAGE UPLOAD (which attaches to a
// user-role message) is never miscounted as a generation. Verified: 27/27 observed image file entries
// were on assistant messages.
import type { AiUsageChatInput, AiUsageUserInput } from '@hnet/domain';

/** In-cluster default (the OWUI service DNS); overridable via OPENWEBUI_URL. */
export const OPENWEBUI_CLUSTER_URL_DEFAULT = 'http://open-webui.ai.svc.cluster.local';

export class OpenWebUiConfigError extends Error {
  constructor(missing: string) {
    super(`Open WebUI config missing: ${missing}`);
    this.name = 'OpenWebUiConfigError';
  }
}

export interface OpenWebUiClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout (ms); default 30s. */
  timeoutMs?: number;
  /** Injected fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

// ── Raw OWUI wire shapes (only the fields we read) ────────────────────────────────────────────────
interface RawOwuiMessage {
  role?: string;
  model?: string;
  content?: string;
  timestamp?: number;
  files?: Array<{ type?: string; url?: string } | null> | null;
  usage?: { total_tokens?: number; total_duration?: number } | null;
}
interface RawOwuiChat {
  id?: string;
  user_id?: string;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  archived?: boolean;
  chat?: { models?: string[] | null; messages?: RawOwuiMessage[] | null } | null;
}
interface RawOwuiUser {
  id?: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export class OpenWebUiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenWebUiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Open WebUI GET ${path} → HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /api/v1/chats/all/db — every chat with its blob (admin api-key gated). */
  async getAllChats(): Promise<RawOwuiChat[]> {
    const body = await this.get<RawOwuiChat[]>('/api/v1/chats/all/db');
    return Array.isArray(body) ? body : [];
  }

  /** GET /api/v1/users/ — the admin user list ({ users:[…] } or a bare array, tolerated). */
  async getUsers(): Promise<RawOwuiUser[]> {
    const body = await this.get<RawOwuiUser[] | { users?: RawOwuiUser[] }>('/api/v1/users/');
    if (Array.isArray(body)) return body;
    return Array.isArray(body?.users) ? body.users : [];
  }
}

/** Build the read client from env (OPENWEBUI_URL default = the in-cluster service DNS; OPENWEBUI_API_KEY
 *  required — throws OpenWebUiConfigError naming the absent variable, never its value). */
export function openWebUiClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenWebUiClient {
  const baseUrl = env.OPENWEBUI_URL?.trim() || OPENWEBUI_CLUSTER_URL_DEFAULT;
  const apiKey = env.OPENWEBUI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new OpenWebUiConfigError('OPENWEBUI_API_KEY');
  return new OpenWebUiClient({ baseUrl, apiKey });
}

/** Epoch-seconds (OWUI) → Date; tolerant of missing/0 (falls back to `now`). */
function secondsToDate(seconds: number | undefined, fallback: Date): Date {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  return new Date(seconds * 1000);
}

/**
 * Reduce one raw OWUI chat to the aggregates the mirror stores (the image-gen heuristic + duration/token
 * sums). Skips a chat with no id (returns null). `primaryModel` = the most-used assistant model, else the
 * chat's first declared model.
 */
export function normalizeOwuiChat(raw: RawOwuiChat, now: Date = new Date()): AiUsageChatInput | null {
  if (!raw.id || typeof raw.id !== 'string') return null;
  const messages = Array.isArray(raw.chat?.messages) ? raw.chat!.messages! : [];

  const modelCounts = new Map<string, number>();
  let imageCount = 0;
  let totalTokens = 0;
  let totalDurationNs = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      if (typeof m.model === 'string' && m.model) {
        modelCounts.set(m.model, (modelCounts.get(m.model) ?? 0) + 1);
      }
      if (Array.isArray(m.files)) {
        for (const f of m.files) {
          if (f && typeof f === 'object' && f.type === 'image') imageCount += 1;
        }
      }
      if (m.usage) {
        if (typeof m.usage.total_tokens === 'number') totalTokens += m.usage.total_tokens;
        if (typeof m.usage.total_duration === 'number') totalDurationNs += m.usage.total_duration;
      }
    }
  }

  // Distinct models: the chat's declared list ∪ the per-assistant-message models.
  const declared = Array.isArray(raw.chat?.models)
    ? raw.chat!.models!.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const models = Array.from(new Set([...declared, ...modelCounts.keys()]));

  // Primary = the most-used assistant model; else the first declared model; else null.
  let primaryModel: string | null = declared[0] ?? null;
  let best = -1;
  for (const [model, n] of modelCounts) {
    if (n > best) {
      best = n;
      primaryModel = model;
    }
  }

  const createdAt = secondsToDate(raw.created_at, now);
  const updatedAt = secondsToDate(raw.updated_at, createdAt);

  return {
    owuiChatId: raw.id,
    owuiUserId: typeof raw.user_id === 'string' ? raw.user_id : '',
    title: typeof raw.title === 'string' ? raw.title : null,
    models,
    primaryModel,
    messageCount: messages.length,
    imageCount,
    totalTokens,
    totalDurationMs: Math.round(totalDurationNs / 1_000_000),
    chatCreatedAt: createdAt,
    chatUpdatedAt: updatedAt,
    archived: raw.archived === true,
  };
}

export function normalizeOwuiUser(raw: RawOwuiUser): AiUsageUserInput | null {
  if (!raw.id || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : null,
    email: typeof raw.email === 'string' ? raw.email : null,
    role: typeof raw.role === 'string' ? raw.role : null,
  };
}

export interface OwuiUsageFetch {
  chats: AiUsageChatInput[];
  users: AiUsageUserInput[];
}

/** Fetch + normalize the OWUI usage snapshot (chats + users) the `ai-usage-sync` mode hands to the
 *  @hnet/domain syncAiUsage single-writer. Users are best-effort — a users read failure degrades to an
 *  empty user set (chats still sync; attribution is simply unresolved that cycle). */
export async function fetchOwuiUsage(
  client: OpenWebUiClient,
  now: Date = new Date(),
): Promise<OwuiUsageFetch> {
  const rawChats = await client.getAllChats();
  let rawUsers: RawOwuiUser[] = [];
  try {
    rawUsers = await client.getUsers();
  } catch {
    rawUsers = []; // attribution unavailable this cycle — chats still sync
  }
  const chats = rawChats
    .map((c) => normalizeOwuiChat(c, now))
    .filter((c): c is AiUsageChatInput => c !== null);
  const users = rawUsers
    .map((u) => normalizeOwuiUser(u))
    .filter((u): u is AiUsageUserInput => u !== null);
  return { chats, users };
}
