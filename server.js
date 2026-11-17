import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const PROJECT_DIR = process.env.PROJECT_DIR || "/tmp/tgproject";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TGCLOUD_BIN = path.join(HERE, "node_modules", ".bin", "tgcloud");
const MODULES_ROOT = path.join(PROJECT_DIR, "tgcloud");

// ---------- helpers ----------

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Serialize all CLI/file operations: one project directory, one operation at a time.
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function tg(args, timeout = 120_000) {
  return new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
    delete env.MCP_AUTH_TOKEN; // never leak the MCP secret to the CLI
    execFile(
      TGCLOUD_BIN,
      args,
      { cwd: PROJECT_DIR, env, timeout, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const out = `${stdout || ""}${stderr || ""}`.replace(ANSI, "").trim();
        resolve({ code, out: out || (code === 0 ? "(no output)" : String(err?.message || "failed")) });
      }
    );
  });
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const fromCli = ({ code, out }) => text(out, code !== 0);

function safePath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Error("bad path");
  const p = path.resolve(MODULES_ROOT, rel.replace(/^tgcloud\//, ""));
  if (p !== MODULES_ROOT && !p.startsWith(MODULES_ROOT + path.sep)) {
    throw new Error("path must stay inside tgcloud/");
  }
  return p;
}

async function walk(dir, base = dir) {
  let out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

let booted;
function ensureProject() {
  if (!booted) {
    booted = (async () => {
      await fs.mkdir(PROJECT_DIR, { recursive: true });
      const marker = path.join(PROJECT_DIR, "tgcloud.jsonc");
      let exists = true;
      try {
        await fs.access(marker);
      } catch {
        exists = false;
      }
      if (!exists) {
        const init = await tg(["init"]);
        console.log("[boot] tgcloud init:", init.code, init.out.slice(0, 300));
        try {
          await fs.access(marker);
        } catch {
          await fs.writeFile(marker, "{}\n");
        }
        if (process.env.TGCLOUD_TOKEN) {
          const pull = await tg(["pull"]);
          console.log("[boot] tgcloud pull:", pull.code, pull.out.slice(0, 300));
        }
      }
      for (const d of ["handlers", "endpoints", "lib"]) {
        await fs.mkdir(path.join(MODULES_ROOT, d), { recursive: true });
      }
    })().catch((e) => {
      booted = undefined;
      throw e;
    });
  }
  return booted;
}

function needToken() {
  return process.env.TGCLOUD_TOKEN
    ? null
    : text("TGCLOUD_TOKEN is not set on the server (BotFather -> your bot -> Serverless -> CLI Access).", true);
}

// Wraps a handler: boots the project, checks token, serializes execution.
function guarded(fn, { token = true } = {}) {
  return async (args) => {
    try {
      if (token) {
        const miss = needToken();
        if (miss) return miss;
      }
      return await serial(async () => {
        await ensureProject();
        return fn(args || {});
      });
    } catch (e) {
      return text(`Error: ${e.message}`, true);
    }
  };
}

const moduleName = z
  .string()
  .regex(/^[A-Za-z0-9_\-/.]+$/, "letters, digits, _ - / . only")
  .refine((s) => !s.includes(".."), "no ..");

// ---------- MCP server ----------

function buildServer() {
  const server = new McpServer({ name: "tgcloud-mcp", version: "0.1.0" });

  server.registerTool(
    "tgcloud_status",
    { title: "Status", description: "Show what changed locally vs. the deployed copy (tgcloud status).", inputSchema: {} },
    guarded(async () => fromCli(await tg(["status"])))
  );

  server.registerTool(
    "tgcloud_diff",
    { title: "Diff", description: "Line-by-line local changes vs. the deployed copy (tgcloud diff).", inputSchema: {} },
    guarded(async () => fromCli(await tg(["diff"])))
  );

  server.registerTool(
    "tgcloud_pull",
    {
      title: "Pull",
      description: "Overwrite local working files with the deployed cloud state (tgcloud pull). Discards unpushed local edits.",
      inputSchema: {},
    },
    guarded(async () => fromCli(await tg(["pull"])))
  );

  server.registerTool(
    "tgcloud_fetch",
    { title: "Fetch", description: "Check what is deployed without touching local files (tgcloud fetch).", inputSchema: {} },
    guarded(async () => fromCli(await tg(["fetch"])))
  );

  server.registerTool(
    "tgcloud_push",
    {
      title: "Push (deploy)",
      description:
        "Deploy modules to the bot (tgcloud push). Without files deploys the whole project and removes cloud modules missing locally. Does NOT change the database; use tgcloud_migrate for that. Never uses --force.",
      inputSchema: {
        files: z.array(moduleName).optional().describe("Optional targeted push, e.g. ['handlers/message.js']"),
      },
    },
    guarded(async ({ files }) => fromCli(await tg(["push", ...(files || [])])))
  );

  server.registerTool(
    "tgcloud_migrate",
    {
      title: "Migrate database",
      description:
        "Apply schema.js changes to the bot database. mode=dry_run prints pending changes only (default). mode=safe applies only additive changes. mode=all also applies destructive changes (drops) and requires confirm=true.",
      inputSchema: {
        mode: z.enum(["dry_run", "safe", "all"]).default("dry_run"),
        confirm: z.boolean().optional().describe("Must be true for mode=all"),
      },
    },
    guarded(async ({ mode = "dry_run", confirm }) => {
      if (mode === "all" && confirm !== true) {
        return text("mode=all can drop data. Re-run with confirm=true after reviewing a dry_run.", true);
      }
      const flag = mode === "safe" ? "--safe" : mode === "all" ? "--yes" : "--dry-run";
      return fromCli(await tg(["migrate", flag]));
    })
  );

  server.registerTool(
    "tgcloud_run",
    {
      title: "Run module",
      description:
        "Execute a handler/endpoint on the platform using LOCAL files, without deploying (tgcloud run). payload and ctx are JSON5 objects.",
      inputSchema: {
        module: moduleName.describe("e.g. handlers/message or endpoints/getProfile"),
        payload: z.string().default("{}").describe("JSON5 object passed to the module"),
        ctx: z.string().optional().describe("JSON5 ctx object"),
      },
    },
    guarded(async ({ module, payload = "{}", ctx }) => {
      const args = ["run", module, payload];
      if (ctx) args.push("--ctx", ctx);
      return fromCli(await tg(args));
    })
  );

  server.registerTool(
    "tgcloud_webhook",
    {
      title: "Webhook",
      description: "Show webhook state, or re-sync it with deployed handlers (tgcloud webhook [sync]).",
      inputSchema: {
        sync: z.boolean().default(false),
        drop_pending: z.boolean().default(false).describe("Only with sync=true: discard queued updates"),
      },
    },
    guarded(async ({ sync = false, drop_pending = false }) => {
      const args = ["webhook"];
      if (sync) {
        args.push("sync");
        if (drop_pending) args.push("--drop-pending");
      }
      return fromCli(await tg(args));
    })
  );

  server.registerTool(
    "tgcloud_add",
    {
      title: "Scaffold module",
      description: "Scaffold a new module (tgcloud add), e.g. handlers/callback_query, endpoints/getProfile, lib/cart.",
      inputSchema: { target: moduleName },
    },
    guarded(async ({ target }) => fromCli(await tg(["add", target])))
  );

  server.registerTool(
    "list_modules",
    { title: "List modules", description: "List .js files under tgcloud/ in the working copy.", inputSchema: {} },
    guarded(async () => text((await walk(MODULES_ROOT)).join("\n") || "(empty)"), { token: false })
  );

  server.registerTool(
    "read_module",
    {
      title: "Read module",
      description: "Read a file under tgcloud/ (path relative to tgcloud/, e.g. schema.js or handlers/message.js).",
      inputSchema: { path: moduleName },
    },
    guarded(async ({ path: p }) => text(await fs.readFile(safePath(p), "utf8")), { token: false })
  );

  server.registerTool(
    "write_module",
    {
      title: "Write module",
      description:
        "Create or overwrite a .js file under tgcloud/ in the working copy. Not deployed until tgcloud_push. Layout: schema.js, handlers/*.js and endpoints/*.js (flat), lib/** (nested ok).",
      inputSchema: { path: moduleName, content: z.string().max(500_000) },
    },
    guarded(async ({ path: p, content }) => {
      const full = safePath(p);
      if (!full.endsWith(".js")) return text("Only .js files can be written.", true);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
      return text(`Wrote ${path.relative(MODULES_ROOT, full)} (${content.length} bytes). Run tgcloud_push to deploy.`);
    }, { token: false })
  );

  server.registerTool(
    "delete_module",
    {
      title: "Delete module",
      description: "Delete a file under tgcloud/ in the working copy. A full tgcloud_push then removes it in the cloud too.",
      inputSchema: { path: moduleName },
    },
    guarded(async ({ path: p }) => {
      await fs.rm(safePath(p), { force: true });
      return text(`Deleted ${p}.`);
    }, { token: false })
  );

  return server;
}

// ---------- HTTP ----------

const sha = (s) => crypto.createHash("sha256").update(s).digest();

function auth(req, res, next) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return res.status(503).json({ error: "MCP_AUTH_TOKEN is not configured" });
  const h = req.headers.authorization || "";
  // Bearer header, or ?key=... for clients (e.g. claude.ai custom connectors) that cannot send headers.
  const given = h.startsWith("Bearer ") ? h.slice(7) : typeof req.query.key === "string" ? req.query.key : "";
  if (!crypto.timingSafeEqual(sha(given), sha(expected))) return res.status(401).json({ error: "unauthorized" });
  next();
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/mcp", auth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("mcp error", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", auth, notAllowed);
app.delete("/mcp", auth, notAllowed);

app.listen(PORT, () => {
  console.log(`tgcloud-mcp listening on :${PORT}`);
  ensureProject().catch((e) => console.error("[boot] failed:", e.message));
});
