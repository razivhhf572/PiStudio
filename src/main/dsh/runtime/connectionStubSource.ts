/**
 * pideck-connection-stub 插件源码（字符串形式，hostEntry 启动时写入 configDir）。
 *
 * 为什么存在：PiStudio 的 DSH host 是 headless（无 dsh-client-connection 的
 * WebSocket 桥），而社区插件（如 dsh-mcp-manager）`inject: ["connection", ...]`
 * 需要 ctx.connection.rpc.handle() 注册 RPC 通道。本 stub 提供最小 connection
 * 服务：rpc.handle 注册表 + 经 pideckMcpRouter 服务暴露给 hostEntry fetch 桥。
 *
 * 信封契约对齐 dsh-client-connection 的 rpcFetchHandler（方案 B 实测确认）：
 *   POST /<channel>/<endpoint>  body = { rpcId, method, payload }
 *   响应 = { type: "server-response", rpcId, result }（result 即 handler 返回值）
 * handler 签名：handler(endpoint, payload, signal) → result
 *
 * WebSocket 事件流（浏览器专用）不在本 stub 范围——mcp-manager 只走 HTTP RPC。
 */
export const CONNECTION_STUB_SOURCE = `/**
 * pideck-connection-stub：headless DSH host 的最小 connection 服务（方案 B）。
 * 由 PiStudio hostEntry 在启动时写入本目录并挂进 cordis 组合。
 */
export default {
  name: "pideck-connection-stub",
  apply(ctx) {
    /** channel -> { handler, options } */
    const channels = new Map();

    const connection = {
      rpc: {
        handle(channel, handler, options) {
          if (typeof channel !== "string" || !channel.startsWith("/") || typeof handler !== "function") {
            return () => {};
          }
          channels.set(channel, { handler, options });
          return () => {
            channels.delete(channel);
          };
        },
      },
    };

    /** 从 URL pathname 拆 channel + endpoint（对齐 endpointFromPath：单段校验）。 */
    function splitPath(pathname) {
      if (!pathname.startsWith("/")) return undefined;
      const segments = pathname.split("/").filter((segment) => segment !== "");
      if (segments.length < 2) return undefined;
      const channel = "/" + segments[0];
      const endpoint = segments.slice(1).join("/");
      if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
      return { channel, endpoint };
    }

    /**
     * fetch 桥分发：hostEntry 把 /<channel>/ 前缀请求转到这里。
     * 信封与响应对齐 dsh-client-connection 的 rpcFetchHandler。
     */
    async function dispatch(url, init) {
      const parsed = splitPath(url.pathname);
      if (parsed === undefined) {
        return new Response("not found", { status: 404 });
      }
      const reg = channels.get(parsed.channel);
      if (reg === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (((init && init.method) || "GET").toUpperCase() !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      let body;
      try {
        body = JSON.parse(init && init.body ? init.body : "{}");
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = typeof body.rpcId === "string" ? body.rpcId : "unknown";
      if (body.method !== parsed.endpoint) {
        return new Response(
          JSON.stringify({
            type: "server-response",
            rpcId,
            result: { ok: false, error: { code: "bad-request", message: "method does not match endpoint" } },
          }),
          { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
      try {
        const result = await reg.handler(parsed.endpoint, body.payload, init && init.signal);
        return new Response(
          JSON.stringify({ type: "server-response", rpcId, result }),
          { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
        );
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
