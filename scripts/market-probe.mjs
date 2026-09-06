#!/usr/bin/env node
/**
 * dshmarket 挂载探针（方案 A POC 验证）。
 *
 * 复刻 hostEntry.ts 的组装（storage/workspace/api-gateway + pideck-webserver-stub
 * + dshmarket），用 toFetchHandler 包装出同款 fetch 桥，验证：
 *   1. boot 组合成功（webServer/loader 注入不挂起）
 *   2. stub 的 register 被 dshmarket 调用（路由表非空）
 *   3. /dsh-market/api/v1/capabilities 返回 200 JSON
 *
 * 用法：
 *   node scripts/market-probe.mjs [--keep-home] [--timeout <ms>]
 *   DSH_HOME 缺省用临时目录；--keep-home 用真实 ~/.dsh（profile pistudio 已在）。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";
import * as yaml from "js-yaml";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

const argv = process.argv.slice(2);
const keepHome = argv.includes("--keep-home");
const timeoutMs = Number(argv[argv.indexOf("--timeout") + 1] ?? "90000");
const log = (prefix, ...rest) => console.log(`[${prefix}]`, ...rest);

/** hostEntry 同款 webServer stub 源码（与 src/main/dsh/runtime/webserverStubSource.ts 同源）。 */
const WEBSERVER_STUB_SOURCE = `import { Readable } from "node:stream";

export default {
  name: "pideck-webserver-stub",
  apply(ctx) {
    const routes = new Map();
    const webServer = {
      register(route) {
        if (!route || (route.kind !== "exact" && route.kind !== "prefix") || typeof route.path !== "string" || typeof route.handler !== "function") return () => {};
        const key = route.kind + ":" + route.path;
        routes.set(key, route);
        return () => { routes.delete(key); };
      },
    };
    function matchRoute(pathname) {
      for (const route of routes.values()) if (route.kind === "exact" && route.path === pathname) return route;
      for (const route of routes.values()) if (route.kind === "prefix" && pathname.startsWith(route.path)) return route;
      return undefined;
    }
    async function dispatch(url, init) {
      const pathname = url.pathname;
      const route = matchRoute(pathname);
      if (!route) {
        return new Response(JSON.stringify({ ok: false, error: "no route for " + pathname }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      const method = ((init && init.method) || "GET").toUpperCase();
      const headers = {};
      if (init && init.headers && typeof init.headers === "object") {
        for (const [key, value] of Object.entries(init.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
      }
      if (headers.host === undefined) headers.host = url.host || "dsh.internal";
      headers.origin = headers.origin || "http://" + headers.host;
      const body = typeof init.body === "string" && init.body.length > 0 ? init.body : undefined;
      const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
      request.method = method;
      request.url = url.pathname + url.search;
      request.headers = headers;
      request.socket = { remoteAddress: "127.0.0.1" };
      let chunks = [];
      let settled = false;
      const response = {
        statusCode: 200,
        headers: {},
        writeHead(status, writeHeaders) {
          this.statusCode = status;
          if (Array.isArray(writeHeaders)) { for (let i = 0; i + 1 < writeHeaders.length; i += 2) this.headers[writeHeaders[i]] = writeHeaders[i + 1]; }
          else if (writeHeaders && typeof writeHeaders === "object") Object.assign(this.headers, writeHeaders);
        },
        setHeader(key, value) { this.headers[key] = value; },
        getHeader(key) { return this.headers[key]; },
        write(chunk) { if (chunk !== undefined && chunk !== null && chunk !== "") chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
        end(chunk) { if (chunk !== undefined && chunk !== null && chunk !== "") chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); settled = true; },
      };
      let handlerError = null;
      try { await route.handler(request, response); } catch (error) { handlerError = error; }
      if (!settled) {
        response.statusCode = handlerError ? 500 : response.statusCode;
        response.headers["content-type"] = "application/json; charset=utf-8";
        response.end(JSON.stringify({ ok: false, error: handlerError && handlerError.message ? handlerError.message : String(handlerError || "no response") }));
      }
      return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { status: response.statusCode, headers: response.headers });
    }
    ctx.provide("webServer", webServer);
    ctx.provide("pideckMarketRouter", { dispatch });
  },
};
`;

/** 模块级标志：本脚本创建的临时 DSH_HOME 才清理（真实 home 绝不删）。 */
let homeIsTemp = false;

/** hostEntry 同款 connection stub 源码（与 src/main/dsh/runtime/connectionStubSource.ts 同源）。 */
const CONNECTION_STUB_SOURCE = `export default {
  name: "pideck-connection-stub",
  apply(ctx) {
    const channels = new Map();
    const connection = {
      rpc: {
        handle(channel, handler, options) {
          if (typeof channel !== "string" || !channel.startsWith("/") || typeof handler !== "function") return () => {};
          channels.set(channel, { handler, options });
          return () => { channels.delete(channel); };
        },
      },
    };
    function splitPath(pathname) {
      if (!pathname.startsWith("/")) return undefined;
      const segments = pathname.split("/").filter((segment) => segment !== "");
      if (segments.length < 2) return undefined;
      const channel = "/" + segments[0];
      const endpoint = segments.slice(1).join("/");
      if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
      return { channel, endpoint };
    }
    async function dispatch(url, init) {
      const parsed = splitPath(url.pathname);
      if (parsed === undefined) return new Response("not found", { status: 404 });
      const reg = channels.get(parsed.channel);
      if (reg === undefined) return new Response("not found", { status: 404 });
      if (((init && init.method) || "GET").toUpperCase() !== "POST") return new Response("method not allowed", { status: 405 });
      let body;
      try { body = JSON.parse(init && init.body ? init.body : "{}"); } catch { return new Response("body is not JSON", { status: 400 }); }
      const rpcId = typeof body.rpcId === "string" ? body.rpcId : "unknown";
      if (body.method !== parsed.endpoint) {
        return new Response(JSON.stringify({ type: "server-response", rpcId, result: { ok: false, error: { code: "bad-request", message: "method does not match endpoint" } } }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      try {
        const result = await reg.handler(parsed.endpoint, body.payload, init && init.signal);
        return new Response(JSON.stringify({ type: "server-response", rpcId, result }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (error) {
        return new Response("handler failure: " + String(error), { status: 500 });
      }
    }
    ctx.provide("connection", connection);
    ctx.provide("pideckMcpRouter", {
      dispatch,
      channels() { return Array.from(channels.keys()); },
    });
  },
};
`;

async function main() {
  // ── DSH_HOME ────────────────────────────────────────────────────────────────
  let dshHome;
  if (keepHome) {
    dshHome = process.env.DSH_HOME || join(osHomedir(), ".dsh");
  } else {
    dshHome = mkdtempSync(join(tmpdir(), "pideck-market-probe-"));
    homeIsTemp = true;
    // 拷贝真实凭证（模型调用不需要，但 dshmarket 探测可能读 settings）
    for (const name of [".credentials.yaml", "settings.yaml"]) {
      const src = join(osHomedir(), ".dsh", name);
      if (existsSync(src)) writeFileSync(join(dshHome, name), readFileSync(src));
    }
  }
  process.env.DSH_HOME = dshHome;
  process.env.DSH_TELEMETRY_DISABLED = "1";

  // ── dsh CLI shim（dshmarket spawn `dsh` 命令的入口）───────────────────────
  // probe 是纯 node 进程：shim 指向 node.exe + 项目 node_modules 的 dsh bin.js。
  // 真实 app（DshHost）用 electron.exe + ELECTRON_RUN_AS_NODE（见 writeDshCliShim）。
  const marketBinDir = join(dshHome, ".pideck", "bin");
  mkdirSync(marketBinDir, { recursive: true });
  const dshBinJs = join(projectRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  writeFileSync(
    join(marketBinDir, "dsh.cmd"),
    ["@ECHO off", "SETLOCAL", `"${process.execPath}" "${dshBinJs}" %*`, "ENDLOCAL", ""].join("\r\n"),
    "utf8",
  );
  process.env.PATH = `${marketBinDir}${delimiter}${process.env.PATH ?? ""}`;
  log("shim", `dsh.cmd -> ${dshBinJs}，PATH 已注入 ${marketBinDir}`);
  // profile pistudio（dshmarket 的安装目标，A1 甲 = ~/.dsh/profiles/pistudio）
  const profileDir = join(dshHome, "profiles", "pistudio");
  mkdirSync(profileDir, { recursive: true });
  const profilePkg = join(profileDir, "package.json");
  if (!existsSync(profilePkg)) {
    writeFileSync(profilePkg, JSON.stringify({ name: "pistudio-profile", version: "0.0.1", private: true, dependencies: {} }, null, 2));
  }
  log("home", `DSH_HOME=${dshHome}${keepHome ? "（真实 home，--keep-home）" : "（临时）"}`);
  log("profile", `profile=pistudio dir=${profileDir}`);

  // ── 组合：与 hostEntry.ts 同款 patches ──────────────────────────────────────
  const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
  const patches = loadOverlayPatches("pideck-market-probe", basePatchPath);
  patches.push({ id: "hmr", disabled: true });
  patches.push({ id: "session-telemetry-otel", disabled: true });
  const configDir = mkdtempSync(join(tmpdir(), "pideck-market-config-"));
  const configPath = join(configDir, "cordis.yml");
  writeFileSync(configPath, "[]\n");
  writeFileSync(
    join(configDir, "pideck-directory-picker.js"),
    ["export default {", "  apply(ctx) {", "    ctx.provide('directoryPicker', {", "      capability() { return { kind: 'none' }; },", "    });", "  },", "};", ""].join("\n"),
  );
  writeFileSync(join(configDir, "pideck-webserver-stub.js"), WEBSERVER_STUB_SOURCE, "utf8");
  writeFileSync(join(configDir, "pideck-connection-stub.js"), CONNECTION_STUB_SOURCE, "utf8");
  // bundle 恢复（与 hostEntry 同款）：profile dsh.profile.bundles → 读各包
  // cordis.patch.yml 的 insert 行，name 绝对路径化后作为 loader entries。
  const marketProfileDir = join(dshHome, "profiles", "pistudio");
  const bundleIncludes = [];
  try {
    const manifestPath = join(marketProfileDir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.filter((b) => typeof b === "string") : [];
      for (const bundleName of bundles) {
        try {
          const pkgDir = join(marketProfileDir, "node_modules", bundleName);
          const pkgPath = join(pkgDir, "package.json");
          if (!existsSync(pkgPath)) continue;
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const patchRel = pkg?.dsh?.bundle?.patch;
          if (typeof patchRel !== "string" || !patchRel) continue;
          const patchPath = join(pkgDir, patchRel);
          if (!existsSync(patchPath)) continue;
          const rows = yaml.load(readFileSync(patchPath, "utf8"));
          for (const row of Array.isArray(rows) ? rows : []) {
            for (const item of Array.isArray(row?.insert) ? row.insert : []) {
              if (typeof item?.id !== "string" || typeof item?.name !== "string") continue;
              const entryPkgPath = join(marketProfileDir, "node_modules", item.name, "package.json");
              let entry;
              try {
                const entryPkg = JSON.parse(readFileSync(entryPkgPath, "utf8"));
                entry = join(marketProfileDir, "node_modules", item.name, typeof entryPkg?.main === "string" ? entryPkg.main : "lib/index.js");
              } catch {
                entry = join(marketProfileDir, "node_modules", item.name, "lib/index.js");
              }
              bundleIncludes.push({
                id: `bundle-${bundleName}-${item.id}`,
                name: pathToFileURL(entry).href,
                ...(item.config !== undefined ? { config: item.config } : {}),
              });
            }
          }
        } catch { /* 单个失败跳过 */ }
      }
    }
  } catch { /* 跳过恢复 */ }
  // 用户级 MCP patch 层（与 hostEntry 同款）：mcp-manager 写的 web/cordis.patch.yml
  // 是 patch 操作数组，解析 insert 行生成 loader entry（name 经 require 解析成绝对路径）。
  const webPatchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");
  const mcpPatchEntries = [];
  if (existsSync(webPatchPath)) {
    try {
      const rows = yaml.load(readFileSync(webPatchPath, "utf8"));
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const item of Array.isArray(row?.insert) ? row.insert : []) {
          if (typeof item?.id !== "string" || typeof item?.name !== "string") continue;
          // name 保留裸名（mcp-manager 的 list 按裸名过滤条目；dsh-mcp-client 在 runtime 锚可解析）
          try { require.resolve(item.name); } catch { continue; }
          mcpPatchEntries.push({ id: item.id, name: item.name, ...(item.config !== undefined ? { config: item.config } : {}) });
        }
      }
    } catch { /* 文件损坏跳过 */ }
  }
  patches.push({
    insert: [
      { id: "storage", name: "@deepseek-ai/dsh-storage" },
      { id: "storage-json", name: "@deepseek-ai/dsh-storage-json", config: { root: { __jsExpr: "dshHomePath('storages')" } } },
      { id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
      { id: "workspace", name: "@deepseek-ai/dsh-workspace" },
      { id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
      { id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
      // dshmarket（方案 A）：headless host 无 webServer → 最小 stub 提供 webServer/loader；
      // profile 'pistudio' = DSH_HOME/profiles/pistudio（dsh CLI 官方约定路径）。
      { id: "pideck-webserver-stub", name: join(configDir, "pideck-webserver-stub.js") },
      { id: "dsh-market", name: require.resolve("dshmarket"), config: { profile: "pistudio", allowRestart: false } },
      // 方案 B：connection stub + 已装 bundle 恢复 + 用户 MCP patch 层。
      { id: "pideck-connection-stub", name: join(configDir, "pideck-connection-stub.js") },
      ...bundleIncludes,
      ...mcpPatchEntries,
    ],
  });
  log("compose", `patches=${patches.length} 条（含 dshmarket + webserver/connection stub + ${bundleIncludes.length} bundles）`);

  // ── boot ────────────────────────────────────────────────────────────────────
  const bootStartedAt = Date.now();
  let ctx;
  try {
    ctx = await boot(
      "pideck-market-probe",
      configPath,
      patches,
      (hostCtx) => {
        provideCmdline(hostCtx, { args: [], exit: (code) => log("appExit", `host 请求退出 code=${code}`) });
      },
      pathToFileURL(join(projectRoot, "node_modules") + "/").href,
    );
  } catch (error) {
    log("boot", `FAILED：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
  log("boot", `OK，耗时 ${Date.now() - bootStartedAt}ms`);
  for (const svc of ["agents", "apiProxy", "sessions", "tools", "llm", "settings", "webServer", "loader", "pideckMarketRouter"]) {
    log("svc", `ctx.${svc} = ${ctx.get(svc) !== undefined ? "present" : "MISSING"}`);
  }
  const loadedPlugins = ctx.plugins ? Array.from(ctx.plugins.keys()).slice(0, 40) : [];
  log("plugins", `ctx.plugins（${loadedPlugins.length}）: ${loadedPlugins.join(", ")}`);
  // cordis 插件 fiber 异步加载：boot 返回可能早于插件就绪，等 3s 再查市场服务。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
  const webServer = ctx.get("webServer");
  const marketRouter = ctx.get("pideckMarketRouter");
  log("svc", `webServer=${webServer !== undefined ? "present" : "MISSING"}  pideckMarketRouter=${marketRouter !== undefined ? "present" : "MISSING"}`);
  if (!marketRouter) {
    log("fail", "pideckMarketRouter 未提供——dshmarket 未挂载或 stub 未生效");
    return 1;
  }

  // ── fetch 桥同款 handler：/dsh-market/* 走 marketRouter，其余走 apiProxy ───
  const apiHandler = toFetchHandler(ctx.apiProxy);
  const handler = (url, init) => {
    if (url.pathname.startsWith("/dsh-market/")) return marketRouter.dispatch(url, init);
    return apiHandler.fetch(url, init);
  };

  // ── 验证 1：capabilities ────────────────────────────────────────────────────
  const timeout = setTimeout(() => { log("fail", `capabilities 超时（${timeoutMs}ms）`); process.exit(2); }, timeoutMs);
  const probe = async (path, method = "GET", body) => {
    const res = await handler(new URL(path, "http://dsh.internal"), {
      method,
      headers: { host: "dsh.internal", origin: "http://dsh.internal" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  try {
    const cap = await probe("/dsh-market/api/v1/capabilities");
    log("capabilities", `HTTP ${cap.status}  ${cap.text.slice(0, 400)}`);
    if (cap.status !== 200) { log("fail", "capabilities 非 200"); return 1; }
  } catch (error) {
    log("fail", `capabilities 请求失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    clearTimeout(timeout);
  }

  // ── 验证 2：注册表快照（市场目录） + 状态 + 已装列表 ──────────────────────
  const probes = [
    ["/dsh-market/registry", "registry 快照"],
    ["/dsh-market/status", "status"],
    ["/dsh-market/installed", "installed"],
  ];
  for (const [path, label] of probes) {
    try {
      const res = await probe(path);
      const parsed = JSON.parse(res.text);
      let count = "?";
      if (Array.isArray(parsed?.plugins)) count = parsed.plugins.length;
      else if (Array.isArray(parsed?.entries)) count = parsed.entries.length;
      log(label, `HTTP ${res.status} 条目数=${count}  ${res.text.slice(0, 240)}`);
    } catch (error) {
      log(label, `失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 验证 3：安装一个 curated registry 内的真实插件（跳过 = 说明装不了） ───
  try {
    const regRes = await probe("/dsh-market/registry");
    const reg = JSON.parse(regRes.text);
    const registryBody = reg?.registry ?? reg;
    const plugins = Array.isArray(registryBody?.plugins) ? registryBody.plugins : [];
    // 挑一个 npm 源的简单插件（避免 GitHub 镜像依赖）；优先 dsh-mcp-toggle（Zenjibad）。
    const pick = plugins.find((p) => String(p.url ?? "").startsWith("npm:"))
      ?? plugins.find((p) => typeof p.url === "string" && p.url.includes("dsh-mcp-toggle"))
      ?? plugins[0];
    log("install", `候选：${pick ? `${pick.name} (${String(pick.url ?? "").slice(0, 80)})` : "无（registry 空）"}`);
    if (pick?.url) {
      const inst = await probe("/dsh-market/install", "POST", { url: pick.url });
      log("install", `HTTP ${inst.status}  ${inst.text.slice(0, 300)}`);
      // 安装后落盘检查：profile package.json 应包含该插件。
      const profilePkgAfter = existsSync(profilePkg) ? JSON.parse(readFileSync(profilePkg, "utf8")) : null;
      const depNames = Object.keys(profilePkgAfter?.dependencies ?? {});
      log("install", `profile deps（${depNames.length}）: ${depNames.join(", ")}`);
      const nodeModulesAt = join(profileDir, "node_modules", ".pnpm");
      log("install", `pnpm store 存在: ${existsSync(nodeModulesAt)}（${existsSync(nodeModulesAt) ? readdirSync(nodeModulesAt).length : 0} 目录）`);
    }
  } catch (error) {
    log("install", `跳过：${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 验证 4：connection RPC（方案 B）——dsh-mcp-manager 的 /mcp-manager 通道 ──
  try {
    const mcpRouter = ctx.get("pideckMcpRouter");
    const registeredChannels = mcpRouter?.channels?.() ?? [];
    log("mcp-rpc", `connection stub 已注册通道: ${JSON.stringify(registeredChannels)}`);
    const rpcResponse = await mcpRouter.dispatch(new URL("/mcp-manager/list", "http://dsh.internal"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rpcId: "probe-1", method: "list", payload: undefined }),
    });
    const rpcText = await rpcResponse.text();
    log("mcp-rpc", `HTTP ${rpcResponse.status}  ${rpcText.slice(0, 400)}`);
    if (rpcResponse.status === 200) {
      const envelope = JSON.parse(rpcText);
      const servers = envelope?.result?.value?.servers;
      log("mcp-rpc", `servers=${Array.isArray(servers) ? servers.length : "?"}  ${JSON.stringify(Array.isArray(servers) ? servers.map((s) => ({ id: s.id, serverName: s.serverName, enabled: s.enabled, toolCount: s.toolCount })) : envelope).slice(0, 300)}`);
    }
  } catch (error) {
    log("mcp-rpc", `失败：${error instanceof Error ? error.message : String(error)}`);
  }

  log("done", "POC 验证完成");
  return 0;
}

main().then((code) => {
  if (homeIsTemp && process.env.DSH_HOME) rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  process.exit(code);
});
