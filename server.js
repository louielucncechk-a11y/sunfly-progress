const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const dataPath = path.join(root, "data", "tracker-data.json");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8765);
const maxBodySize = 10 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": type.startsWith("application/json") ? "no-store" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodySize) {
        reject(Object.assign(new Error("数据超过 10MB 限制"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health" && req.method === "GET") {
    return send(res, 200, JSON.stringify({ ok: true, service: "sunfly-progress", publicUrl: "https://progress.sunfly.hk" }));
  }
  if (pathname !== "/api/data") return send(res, 404, JSON.stringify({ error: "接口不存在" }));
  if (req.method === "GET") {
    try { return send(res, 200, await fsp.readFile(dataPath, "utf8")); }
    catch { return send(res, 500, JSON.stringify({ error: "无法读取数据文件" })); }
  }
  if (req.method === "PUT") {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.projects)) return send(res, 400, JSON.stringify({ error: "数据结构无效" }));
      data.updatedAt = new Date().toISOString();
      const tempPath = `${dataPath}.tmp`;
      await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await fsp.rename(tempPath, dataPath);
      return send(res, 200, JSON.stringify({ ok: true, updatedAt: data.updatedAt }));
    } catch (error) {
      return send(res, error.status || 400, JSON.stringify({ error: error.message || "保存失败" }));
    }
  }
  res.setHeader("Allow", "GET, PUT");
  return send(res, 405, JSON.stringify({ error: "不支持该请求方式" }));
}

async function serveStatic(req, res, pathname) {
  let relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try { relative = decodeURIComponent(relative); } catch { return send(res, 400, "Bad Request", "text/plain; charset=utf-8"); }
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  try {
    const stat = await fsp.stat(filePath);
    const target = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const type = mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN" });
    fs.createReadStream(target).pipe(res);
  } catch {
    send(res, 404, "页面不存在", "text/plain; charset=utf-8");
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed", "text/plain; charset=utf-8");
  return serveStatic(req, res, pathname);
});

server.listen(port, host, () => {
  console.log(`检测报告进度控制中心已启动：http://${host}:${port}`);
  console.log("关闭本窗口即可停止服务。正式域名：https://progress.sunfly.hk");
});

server.on("error", (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
