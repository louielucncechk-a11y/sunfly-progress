const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTS = 1000;

const ALLOWED_ORIGINS = new Set([
  "https://progress.sunfly.hk",
  "http://progress.sunfly.hk",
  "https://louielucncechk-a11y.github.io",
]);

type TrackerRow = {
  payload: string;
  revision: number;
  updated_at: string;
};

type RevisionRow = { revision: number };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-Match",
    "Access-Control-Expose-Headers": "ETag, X-Revision",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && isAllowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(request: Request, value: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value), { status, headers });
}

async function readLimitedText(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, "数据超过 2 MB 限制");
  if (!request.body) throw new HttpError(400, "请求内容为空");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("payload too large");
        throw new HttpError(413, "数据超过 2 MB 限制");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function validatePayload(value: unknown): asserts value is Record<string, unknown> & { projects: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "数据格式无效");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.projects)) throw new HttpError(400, "缺少 projects 数组");
  if (record.projects.length > MAX_PROJECTS) throw new HttpError(400, `项目数量不能超过 ${MAX_PROJECTS}`);
  for (const project of record.projects) {
    if (!project || typeof project !== "object" || Array.isArray(project)) throw new HttpError(400, "项目记录格式无效");
    const item = project as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.rounds)) {
      throw new HttpError(400, "项目缺少 id、name 或 rounds");
    }
  }
}

function parseIfMatch(value: string | null): number | null {
  if (!value) return null;
  const match = /^W\/"rev-(\d+)"$|^"rev-(\d+)"$/.exec(value.trim());
  const revision = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(400, "If-Match 版本格式无效");
  return revision;
}

function revisionHeaders(revision: number): HeadersInit {
  return { ETag: `"rev-${revision}"`, "X-Revision": String(revision) };
}

async function getData(request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT payload, revision, updated_at FROM tracker_state WHERE id = 1",
  ).first<TrackerRow>();
  if (!row) return jsonResponse(request, { error: "尚未初始化数据" }, 404);
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  Object.entries(revisionHeaders(row.revision)).forEach(([key, value]) => headers.set(key, String(value)));
  return new Response(row.payload, { headers });
}

async function putData(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "仅支持 application/json");
  }
  const raw = await readLimitedText(request);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "JSON 内容无效");
  }
  validatePayload(value);
  const payload = JSON.stringify(value);
  const now = new Date().toISOString();
  const expectedRevision = parseIfMatch(request.headers.get("If-Match"));

  let result: RevisionRow | null;
  if (expectedRevision !== null) {
    result = await env.DB.prepare(
      "UPDATE tracker_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING revision",
    ).bind(payload, now, expectedRevision).first<RevisionRow>();
    if (!result) {
      const current = await env.DB.prepare("SELECT revision FROM tracker_state WHERE id = 1").first<RevisionRow>();
      return jsonResponse(
        request,
        { error: "云端数据已被其他设备更新，请刷新后重新修改", revision: current?.revision ?? null },
        409,
        current ? revisionHeaders(current.revision) : undefined,
      );
    }
  } else {
    result = await env.DB.prepare(
      `INSERT INTO tracker_state (id, payload, revision, updated_at) VALUES (1, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, revision = tracker_state.revision + 1, updated_at = excluded.updated_at
       RETURNING revision`,
    ).bind(payload, now).first<RevisionRow>();
  }
  if (!result) throw new Error("D1 write returned no revision");
  return jsonResponse(request, { ok: true, revision: result.revision, updatedAt: now }, 200, revisionHeaders(result.revision));
}

async function health(request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT revision, updated_at FROM tracker_state WHERE id = 1").first<Pick<TrackerRow, "revision" | "updated_at">>();
  return jsonResponse(request, { ok: true, initialized: Boolean(row), revision: row?.revision ?? null, updatedAt: row?.updated_at ?? null });
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = request.headers.get("CF-Ray") || crypto.randomUUID();
    try {
      if (!isAllowedOrigin(request.headers.get("Origin"))) return jsonResponse(request, { error: "不允许的来源" }, 403);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
      const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
      if (path === "/api/health" && request.method === "GET") return await health(request, env);
      if (path === "/api/data" && request.method === "GET") return await getData(request, env);
      if (path === "/api/data" && request.method === "PUT") return await putData(request, env);
      return jsonResponse(request, { error: "接口不存在" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse(request, { error: error.message }, error.status);
      console.error(JSON.stringify({ event: "request_failed", requestId, method: request.method, path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return jsonResponse(request, { error: "服务器暂时无法处理请求", requestId }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
