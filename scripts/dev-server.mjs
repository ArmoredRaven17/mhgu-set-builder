// dev-server.mjs — static server for docs/ that never lets the browser cache.
//
//   node scripts/dev-server.mjs [port] [dir]
//
// Python's http.server sends Last-Modified and no Cache-Control, so browsers
// fall back to heuristic caching and will serve index.html from cache without
// revalidating. During development that means an edited page — and every
// cache-busting ?v= bump inside it — can be invisible until a hard reload,
// which reads exactly like the app being broken. `no-store` removes the whole
// class of confusion. Deployment is GitHub Pages, which is unaffected by this.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = Number(process.argv[2] || 8128);
const DIR = join(ROOT, process.argv[3] || "docs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

createServer(async (req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, {
      "Content-Type": type || "text/plain; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(body);
  };
  try {
    // Strip the query (the ?v= cache-busters) and refuse to climb out of DIR.
    const rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIR, safe);
    const info = await stat(file).catch(() => null);
    if (info && info.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    send(200, body, TYPES[extname(file).toLowerCase()]);
  } catch {
    send(404, "Not found");
  }
}).listen(PORT, () => {
  console.log(`serving ${DIR} on http://localhost:${PORT} with caching disabled`);
});
