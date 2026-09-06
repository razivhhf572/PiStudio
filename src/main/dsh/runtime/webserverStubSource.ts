/**
 * pideck-webserver-stub 插件源码（字符串形式，hostEntry 启动时写入 configDir）。
 *
 * 为什么存在：PiStudio 的 DSH host 是 headless（无 webServer 服务），而 dshmarket
 * 插件必须 `ctx.inject(['webServer', 'loader'])` 才能挂载 /dsh-market/api/v1/* 路由。
 * 本 stub 提供最小 webServer 服务：register() 存路由表，dispatch() 把 hostEntry
 * fetch 桥的请求适配成 node:http 风格（IncomingMessage / ServerResponse 替身）后
 * 调用 dshmarket 的原路由 handler。
 *
 * 设计要点：
 * - loader 服务给空 entries()（dshmarket 只读它做主题管理，空清单不影响安装功能）；
 * - sameOrigin 校验：桥请求补 host/origin 头为同源（PiStudio fetch 桥本身即受信内网
 *   通道，同源语义由主进程 IPC 白名单保证）；
 * - 响应替身收集 write/end 缓冲后经 ReadableStream 返回——content-type 为
 *   application/json 时走桥的 unary 路径，其余自动走 SSE 流式路径。
 */
export const WEBSERVER_STUB_SOURCE = `/**
 * pideck-webserver-stub：headless DSH host 的最小 webServer 服务（dshmarket 适配）。
 * 由 PiStudio hostEntry 在启动时写入本目录并挂进 cordis 组合。
 */
import { Readable } from "node:stream";

export default {
  name: "pideck-webserver-stub",
  apply(ctx) {
    /** kind:path -> { kind, path, handler } */
    const routes = new Map();

    const webServer = {
      register(route) {
        if (
          !route ||
          (route.kind !== "exact" && route.kind !== "prefix") ||
          typeof route.path !== "string" ||
          typeof route.handler !== "function"
        ) {
          return () => {};
        }
        const key = route.kind + ":" + route.path;
        routes.set(key, route);
        return () => {
          routes.delete(key);
        };
      },
    };

    /** 匹配请求路径：先精确后前缀（与 dshmarket 路由注册语义一致）。 */
    function matchRoute(pathname) {
      for (const route of routes.values()) {
        if (route.kind === "exact" && route.path === pathname) return route;
      }
      for (const route of routes.values()) {
        if (route.kind === "prefix" && pathname.startsWith(route.path)) return route;
      }
      return undefined;
    }

    /** 把 fetch 风格请求适配成 node:http handler 调用，返回标准 Response。 */
    async function dispatch(url, init) {
      const pathname = url.pathname;
      const route = matchRoute(pathname);
      if (!route) {
        return new Response(JSON.stringify({ ok: false, error: "no route for " + pathname }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      const method = ((init && init.method) || "GET").toUpperCase();
      const headers = {};
      if (init && init.headers && typeof init.headers === "object") {
        for (const [key, value] of Object.entries(init.headers)) {
          if (typeof value === "string") headers[key.toLowerCase()] = value;
        }
      }
      // 桥请求补同源 host/origin：dshmarket 的 sameOrigin() 要求 Origin.host === Host。
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
          if (Array.isArray(writeHeaders)) {
            for (let i = 0; i + 1 < writeHeaders.length; i += 2) {
              this.headers[writeHeaders[i]] = writeHeaders[i + 1];
            }
          } else if (writeHeaders && typeof writeHeaders === "object") {
            Object.assign(this.headers, writeHeaders);
          }
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        getHeader(key) {
          return this.headers[key];
        },
        write(chunk) {
          if (chunk !== undefined && chunk !== null && chunk !== "") {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
        },
        end(chunk) {
          if (chunk !== undefined && chunk !== null && chunk !== "") {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          settled = true;
        },
      };

      let handlerError = null;
      try {
        await route.handler(request, response);
      } catch (error) {
        handlerError = error;
      }
      if (!settled) {
        response.statusCode = handlerError ? 500 : response.statusCode;
        response.headers["content-type"] = "application/json; charset=utf-8";
        response.end(
          JSON.stringify({ ok: false, error: handlerError && handlerError.message ? handlerError.message : String(handlerError || "no response") }),
        );
      }

      const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: response.statusCode, headers: response.headers },
      );
    }

    ctx.provide("webServer", webServer);
    ctx.provide("pideckMarketRouter", { dispatch });
  },
};
`;
