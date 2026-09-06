/**
 * DSH host utilityProcess 入口（v2 形态）。
 *
 * 运行在 Electron utilityProcess 里：`boot()` 引导完整 DSH host（组合与主进程内嵌
 * 形态一致），随后通过 `process.parentPort` 响应主进程的 fetch 桥请求——
 * 每个 fetch-request 交给 `toFetchHandler(ctx.apiProxy).fetch()`，响应体
 * （unary JSON 或 SSE 流）按 dshHostBridge 协议逐帧回传。
 *
 * 启动参数（argv）：
 *   --dsh-home <dir>           DSH_HOME（会话/存储/凭证目录）
 *   --dsh-config <dir>         cordis.yml 与本地插件目录
 *   --dsh-node-modules <dir>   bareModuleBaseUrl 锚点（node_modules 目录 URL）
 *
 * 注意：本文件被 electron-vite 主进程构建打包（rollup 多入口），产物为 CJS；
 * @deepseek-ai/* 全部 externalize，运行时动态 import() 加载（与 DshHost 一致）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { installHiddenConsolePatch, installHostHiddenConsole } from "./hideChildConsoles";
import { agentPresetsRow, dshWebAgentPlaneDisableRows } from "./dshPresetComposition";
import { WEBSERVER_STUB_SOURCE } from "./runtime/webserverStubSource";
import { CONNECTION_STUB_SOURCE } from "./runtime/connectionStubSource";
import {
	PIDECK_PLUGIN_BRIDGE_PATH,
	handlePluginBridgeFetch,
} from "./pideckPluginBridge";
import {
	PIDECK_COMMANDS_BRIDGE_PATH,
	handleCommandsBridgeFetch,
} from "./pideckCommandsBridge";

// utilityProcess 的 parentPort：electron 包类型里有（Electron.ParentPort）。
import type { ParentPort } from "electron";

type DshFetchMessage =
	| { type: "fetch-request"; id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
	| { type: "fetch-abort"; id: string };

/** 解析 argv：支持 `--key value` 与 `--key=value` 两种形式。 */
function parseArgv(argv: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			// --key=value
			result[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const key = body;
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			result[key] = value;
			index += 1;
		} else {
			result[key] = "true";
		}
	}
	return result;
}

async function main(): Promise<void> {
	const port = process.parentPort as ParentPort | undefined;
	if (!port) {
		console.error("[dsh-host-entry] no parentPort; this entry must run inside Electron utilityProcess");
		process.exit(1);
	}
	const args = parseArgv(process.argv.slice(2));
	const dshHome = args["dsh-home"];
	const configDir = args["dsh-config"];
	const nodeModulesUrl = args["dsh-node-modules"];
	if (!dshHome || !configDir || !nodeModulesUrl) {
		console.error("[dsh-host-entry] missing required args", { dshHome, configDir, nodeModulesUrl });
		process.exit(1);
	}
	mkdirSync(dshHome, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";

	// Windows 黑窗口治理（必须在下面任何 @deepseek-ai/* 动态 import 之前安装——
	// dsh-subprocess-local 等模块加载时会捕获 child_process.spawn 的引用，
	// 补丁先于加载才覆盖得到）：
	// 1) installHostHiddenConsole：给 host 分配隐藏控制台。utilityProcess 无控制台，
	//    child_process.spawn 拉起控制台子程序时 libuv 自动 CREATE_NO_WINDOW（本地
	//    路径本就不弹窗）；分配隐藏控制台后所有子进程/孙进程继承它，整棵树零弹窗。
	// 2) installHiddenConsolePatch：隐藏控制台分配失败时退回 windowsHide 注入兜底；
	//    并对沙箱 runner 的 spawn 注入 NODE_OPTIONS preload（runner 是 GUI 进程、
	//    不继承 host 控制台，需在 runner 进程内自建隐藏控制台——见 runnerConsolePreload.ts）。
	const hiddenConsoleOk = installHostHiddenConsole();
	installHiddenConsolePatch();
	console.log(`[dsh-host-entry] hidden console: ${hiddenConsoleOk ? "allocated" : "FAILED (fallback windowsHide)"}`);
	// ── 组合：base 补丁 + 覆盖层（ApiProxy/workspace/storage + picker stub + 遥测关）──
	// require base 用宿主 node_modules 目录（DshHost 传 --dsh-node-modules 的 file URL）：
	// 打包后是 app.asar/node_modules（Electron asar patch 生效）；不能用 DSH_HOME（数据目录无包）。
	// 注意：CJS 产物里的裸 import("@deepseek-ai/...") 会走 Node 默认解析（out/main 向上找
	// node_modules），找不到 app 根 node_modules → ERR_MODULE_NOT_FOUND → exit(1)。
	// 必须先用 createRequire 解析出真实文件路径，再按 file URL 动态 import。
	const require = createRequire(join(fileURLToPath(nodeModulesUrl), "package.json"));
	// dshmarket 只随 app 分发（打包进 app.asar/node_modules），runtime node_modules
	// 没有它（dist-runtime 是 @deepseek-ai/* 生态，不含市场）——必须用 app 侧锚解析。
	// hostEntry 打包产物在 app.asar/out/main/，app node_modules = 上两级。
	const appRequire = createRequire(join(__dirname, "../../node_modules/package.json"));
	const importFromApp = (specifier: string) =>
		import(pathToFileURL(require.resolve(specifier)).href);
	const [{ boot, loadOverlayPatches }, { toFetchHandler }, { provideCmdline }] = await Promise.all([
		importFromApp("@deepseek-ai/dsh-app-boot"),
		importFromApp("@deepseek-ai/dsh-host-apiproxy"),
		importFromApp("@deepseek-ai/dsh-cmdline"),
	]);

	const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-dsh", basePatchPath);
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	// 复刻 dsh-web-app/cordis.patch.yml 的「agent plane moves behind agent presets」：
	// 基础层工具必须禁用，否则 minimal/standard/code 等 preset 只是叠加自己的工具，
	// dsh-base 的进程级全局工具仍会对所有会话可见（极简模式失效的根因）。
	for (const row of dshWebAgentPlaneDisableRows()) {
		patches.push(row);
	}
	// 方案 B：用户级 MCP patch 层——dsh-mcp-manager 默认读写
	// $DSH_HOME/profiles/web/cordis.patch.yml（写死 web profile）。该文件是
	// patch 操作数组（- insert: [...]），cordis:include 只接受 loader entries——
	// 直接解析 insert 行生成 loader entry（name 经 runtime 锚解析成绝对路径，
	// config 原样带）；文件损坏/条目解析失败时跳过该条，不阻断启动。
	const webPatchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");
	const mcpPatchEntries: Array<{ id: string; name: string; config?: Record<string, unknown> }> = [];
	if (existsSync(webPatchPath)) {
		try {
			const rows = appRequire("js-yaml").load(readFileSync(webPatchPath, "utf8")) as Array<{ insert?: Array<{ id?: unknown; name?: unknown; config?: Record<string, unknown> }> }> | null;
			for (const row of Array.isArray(rows) ? rows : []) {
				for (const item of Array.isArray(row?.insert) ? row.insert : []) {
					if (typeof item?.id !== "string" || typeof item?.name !== "string") continue;
					// name 保留裸名：dsh-mcp-client 在 runtime node_modules，Loader 按
					// nodeModulesUrl（runtime 锚）解析 ✓；mcp-manager 的 list 按
					// entry.options.name === '@deepseek-ai/dsh-mcp-client' 过滤，
					// 用绝对路径会导致列表恒空。解析不到的条目跳过。
					try {
						require.resolve(item.name);
					} catch {
						continue;
					}
					mcpPatchEntries.push({
						id: item.id,
						name: item.name,
						...(item.config !== undefined ? { config: item.config } : {}),
					});
				}
			}
		} catch {
			// 文件损坏：跳过用户 MCP 层，host 照常启动
		}
	}
	// 方案 A/B 补足：恢复已装插件——dshmarket 把 bundle 持久化在 profile
	// package.json 的 dsh.profile.bundles + 各包 dsh.bundle.patch（patch 内容是
	// `- insert: [{id, name}]` 操作）。host 启动时把每个 bundle 的 insert 行
	// 直接作为 loader entries 加入组合（name 绝对路径化到 profile node_modules
	// 的包入口——profile 的 node_modules 不在 app 解析链上），重启后插件保持加载。
	const marketProfileDir = join(dshHome, "profiles", "pistudio");
	const bundleIncludes: Array<{ id: string; name: string; config?: Record<string, unknown> }> = [];
	try {
		const manifestPath = join(marketProfileDir, "package.json");
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dsh?: { profile?: { bundles?: unknown } } };
			const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
				? manifest.dsh.profile.bundles.filter((bundle): bundle is string => typeof bundle === "string")
				: [];
			for (const bundleName of bundles) {
				try {
					const pkgDir = join(marketProfileDir, "node_modules", bundleName);
					const pkgPath = join(pkgDir, "package.json");
					if (!existsSync(pkgPath)) continue;
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dsh?: { bundle?: { patch?: unknown } }; main?: unknown };
					const patchRel = pkg.dsh?.bundle?.patch;
					if (typeof patchRel !== "string" || !patchRel) continue;
					const patchPath = join(pkgDir, patchRel);
					if (!existsSync(patchPath)) continue;
					const rows = appRequire("js-yaml").load(readFileSync(patchPath, "utf8")) as Array<{ insert?: Array<{ id?: unknown; name?: unknown; config?: Record<string, unknown> }> }> | null;
					for (const row of Array.isArray(rows) ? rows : []) {
						for (const item of Array.isArray(row?.insert) ? row.insert : []) {
							if (typeof item?.id !== "string" || typeof item?.name !== "string") continue;
							// name 绝对路径化：包入口（main 或 lib/index.js）——Loader 走
							// ESM 动态 import，目录裸名解析不到 profile node_modules。
							const entryPkgPath = join(marketProfileDir, "node_modules", item.name, "package.json");
							let entry: string;
							try {
								const entryPkg = JSON.parse(readFileSync(entryPkgPath, "utf8")) as { main?: unknown };
								entry = join(marketProfileDir, "node_modules", item.name, typeof entryPkg.main === "string" ? entryPkg.main : "lib/index.js");
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
				} catch {
					// 单个 bundle 解析失败不阻断启动
				}
			}
		}
	} catch {
		// profile 不可读时跳过恢复（干净启动）
	}
	patches.push({
		insert: [
			{ id: "storage", name: "@deepseek-ai/dsh-storage" },
			{
				id: "storage-json",
				name: "@deepseek-ai/dsh-storage-json",
				config: { root: { __jsExpr: "dshHomePath('storages')" } },
			},
			{ id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
			// 官方投影缓存：与 dsh-web-app 同配置。dsh-web 冷列表只读
			// session_projcache 的 title 行，不 fold 日志；不挂这个插件，
			// PiDeck 会话在 dsh-web 侧栏就会只显示 workspace / 目录名。
			// 写点仍是官方 turn/end + dispose + coldSnapshot 回写，不手写 JSON。
			{
				id: "session-projection-cache",
				name: "@deepseek-ai/dsh-session-projection-cache",
				config: { writeEveryEvents: 200, writeIntervalMs: 5000 },
			},
			// 整段日志回合/步骤计数（sessionStats 投影）：dsh-web StatsLine 同源。
			// 不挂这行，host 不会产出 sessionStats，输入框底下就没有「N 轮 · M 步」。
			{ id: "session-stats", name: "@deepseek-ai/dsh-session-stats" },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			{ id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
			{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
			{ id: "pideck-slash-bridge", name: "./pideck-slash-bridge.js" },
			// 持久 pwsh 工具：继续用本地 dsh-tool-pwsh-persistent，不要换成官方
			// `@deepseek-ai/dsh-tool-pwsh-persistent`。官方工具名是 `pwsh`，会和
			// 一次性沙箱 pwsh 抢名字，且依赖 ctx.terminals + terminal-bash
			//（shellDialect: pwsh），base/standard/code 预设都没挂。绝对路径：
			// utilityProcess 的模块锚在 app node_modules，裸名不一定解析到同一目录。
			{
				id: "tool-pwsh-persistent",
				name: require.resolve("dsh-tool-pwsh-persistent"),
			},
			// Agent preset 名单（standard/code/minimal/cordis 等组合预设）：与 dsh-web
			// 同一部署形态——随包 system 根 + $DSH_HOME/.agent-presets 用户根（插件
			// includeUserRoot 默认追加），默认 standard（标准模式）。不声明该行时
			// agentPreset.list 返回空名单，配置页「预设设置」无模式可选。
			agentPresetsRow(dirname(require.resolve("@deepseek-ai/dsh/package.json"))),
			// 动态 Cordis 插件管理（G13 深化）：运行器（define/run/stop/undefine，
			// 进程内临时扩展、按会话归属）+ 只读静态 Loader 清单 + PiDeck 管理桥。
			// 与 dsh-web-app 的 cordis.patch.yml 同一挂载形态（无 config 的普通行）。
			{ id: "plugin-inventory", name: "@deepseek-ai/dsh-host-plugin-inventory" },
			{ id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
			{ id: "pideck-plugin-bridge", name: join(__dirname, "pideckPluginBridge.js") },
			// 会话命令枚举桥（D15）：host 命令注册表（ctx.commands.list）经
			// /pideck-command/rpc 暴露给主进程，Composer `/` 补全拿到 live 命令
			// （含用户/插件注册的命令），执行仍走 pideck-slash-bridge。
			{ id: "pideck-command-bridge", name: join(__dirname, "pideckCommandsBridge.js") },
			// 用量采集（G16）：成熟第三方 dsh-bill。无 web 硬依赖，钩 llm/stream
			// 落盘 $DSH_HOME/dsh-bill/records.jsonl；PiDeck 费用页只读该日志。
			// inject 为空：headless host 没有 webServer 也能继续记账。
			// name 用绝对路径：host 的模块解析锚在 app node_modules，裸名在
			// utilityProcess 里不一定能走到同一目录。
			{ id: "bill", name: require.resolve("dsh-bill") },
			// PiDeck 最小化收敛：host 层仍保留 bill_stats / pwsh_persistent 供
			// 非 minimal 预设使用，但 minimal 会话必须挡掉这两个全局扩展，
			// 保持与官方 minimal（Windows 为 pwsh + str_replace_editor）一致。
			{
				id: "pideck-minimal-tool-filter",
				name: "./pideck-minimal-tool-filter.js",
			},
			// 插件市场（方案 A）：dshmarket 1.44.0 + 最小 webServer stub（headless host
			// 无 webServer 服务，dshmarket 必须注入 webServer/loader 才能挂路由）。
			// profile 'pistudio' = ~/.dsh/profiles/pistudio（dsh CLI 官方约定，dshmarket
			// profile.ts 默认推导路径，零适配）。allowRestart=false：host 生命周期由
			// PiStudio 主进程（DshHost）管理，不允许市场自重启。
			{ id: "pideck-webserver-stub", name: join(configDir, "pideck-webserver-stub.js") },
			{
				id: "dsh-market",
				name: appRequire.resolve("dshmarket"),
				config: { profile: "pistudio", allowRestart: false },
			},
			// connection stub（方案 B）：headless host 无 dsh-client-connection，
			// 社区插件（dsh-mcp-manager 等）inject ['connection'] 需要 rpc.handle。
			{ id: "pideck-connection-stub", name: join(configDir, "pideck-connection-stub.js") },
			// 恢复已装插件（方案 A/B）：dshmarket 持久化的 profile bundles。
			...bundleIncludes,
			// 用户级 MCP patch 层（方案 B）：mcp-manager 管理的 MCP server 条目。
			...mcpPatchEntries,
		],
	});

	const configPath = join(configDir, "cordis.yml");
	if (!existsSync(configPath)) writeFileSync(configPath, "[]\n");
	const pickerPath = join(configDir, "pideck-directory-picker.js");
	if (!existsSync(pickerPath)) {
		writeFileSync(
			pickerPath,
			[
				"export default {",
				"  apply(ctx) {",
				"    ctx.provide('directoryPicker', {",
				"      capability() { return { kind: 'none' }; },",
				"    });",
				"  },",
				"};",
				"",
			].join("\n"),
		);
	}
	// Slash 命令桥：dsh-web 的命令执行（/permission /plan /compact 等）走浏览器
	// 客户端通道（commands.execute Remote），PiDeck 只有 api-proxy RPC 通道，拿不到
	// 该 Remote。本插件把「以 / 开头的单条用户消息」在 agent/pre-step（步骤组装前）
	// 拦截下来，经 ctx.commands.execute 执行：命中则 reject 该步骤（命令日志事件
	// command/run + command/done 由执行器落盘，消息不进模型、不上时间线），
	// 未命中（未知命令/非命令）原样放行。与 dsh-web 的客户端语义一致。
	const slashBridgePath = join(configDir, "pideck-slash-bridge.js");
	// 该桥是应用修复命令语义的运行时代码，不能只在首次启动时写入；否则已有
	// ~/.dsh 用户会继续使用旧桥，权限切换仍可能退化成普通 prompt。
	writeFileSync(
		slashBridgePath,
		[
			"export default {",
			"  apply(ctx) {",
				"    ctx.inject(['commands'], (commandCtx) => {",
				"      commandCtx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {",
				"        try {",
				"          // 只认 source.kind === 'user' 的输入：回合注入的运行时上下文等",
				"          // 系统消息也作为 user/message 进 claimed 批次，必须排除。",
				"          const userMessages = Array.isArray(messages)",
				"            ? messages.filter((m) => m && m.source && m.source.kind === 'user')",
				"            : [];",
				"          if (userMessages.length !== 1) return next();",
				"          const content = userMessages[0] && userMessages[0].content;",
				"          const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined;",
				"          const line = block && block.type === 'text' && typeof block.text === 'string'",
				"            ? block.text.trim()",
				"            : '';",
				"          if (!line.startsWith('/')) return next();",
				"          // execute 的第三个参数是图片数组，第四个才是取消信号；参数错位会",
				"          // 让命令执行器把 AbortSignal 当数组处理，权限命令随后退化成普通消息。",
				"          const result = await commandCtx.commands.execute(agent, line, [], signal);",
				"          // 未知命令 execute 返回 undefined，只有这种情况才允许模型接管文本。",
				"          // 已知命令无论成功还是失败都必须 reject，避免 slash 行进入时间线/模型。",
				"          if (result === undefined) return next();",
				"          return { kind: 'reject' };",
				"        } catch (error) {",
				"          // 已解析的命令执行失败也不能作为普通用户问题重试一次；命令执行器",
				"          // 会记录 command/done error，reject 可以保持 DSH 的命令语义闭环。",
				"          return { kind: 'reject' };",
				"        }",
				"      });",
				"    });",
				"  }",
				"};",
				"",
			].join("\n"),
		);

	// 极简工具过滤插件：挂在 host 组合里，minimal agent 创建时把 PiDeck 全局
	// 扩展（bill_stats / pwsh_persistent）从继承工具目录中剔除；非 minimal 预设
	// 仍保留这两个扩展。只拦继承层，不动 minimal 自身注册的 bash/pwsh/editor。
	const minimalToolFilterPath = join(configDir, "pideck-minimal-tool-filter.js");
	writeFileSync(
		minimalToolFilterPath,
		[
			"export default {",
			"  name: 'pideck-minimal-tool-filter',",
			"  apply(ctx) {",
			"    ctx.on('agent/created', ({ agent }) => {",
			"      try {",
			"        const presets = ctx.get('agentPresets');",
			"        if (!presets || typeof presets.composedPreset !== 'function') return;",
			"        if (presets.composedPreset(agent.ctx) !== 'minimal') return;",
			"        agent.ctx.tools.restrict({ deny: ['bill_stats', 'pwsh_persistent'] });",
			"      } catch (error) {",
			"        console.warn('[pideck-minimal-tool-filter] failed:', error?.message ?? String(error));",
			"      }",
			"    });",
			"  }",
			"};",
			"",
		].join("\n"),
	);

	// dshmarket 适配：headless host 无 webServer 服务，把最小 webServer stub
	// 写入 configDir 供 cordis 组合加载（与 slash-bridge 同模式，运行时写入）。
	const webserverStubPath = join(configDir, "pideck-webserver-stub.js");
	writeFileSync(webserverStubPath, WEBSERVER_STUB_SOURCE, "utf8");
	// 方案 B：最小 connection stub（rpc.handle 注册表，供 mcp-manager 等社区插件
	// inject ['connection']）。
	const connectionStubPath = join(configDir, "pideck-connection-stub.js");
	writeFileSync(connectionStubPath, CONNECTION_STUB_SOURCE, "utf8");

	const startedAt = Date.now();
	const ctx = await boot(
		"pideck-dsh",
		configPath,
		patches,
		(hostCtx: import("@deepseek-ai/cordis").Context) => {
			provideCmdline(hostCtx, {
				args: [],
				exit: (code: number) => {
					console.log(`[dsh-host-entry] host requested exit code=${code}`);
					port.postMessage({ type: "host-exit", code });
				},
			});
		},
		nodeModulesUrl,
	);
	const apiHandler = toFetchHandler(ctx.apiProxy as never);
	// PiDeck 插件管理桥（G13 深化）：/pideck-plugin/rpc 走桥插件服务（动态插件
	// 生命周期 + 静态 Loader 清单），其余路径原样交给 ApiProxy RPC handler。
	const handler = (url: URL, init?: RequestInit): Promise<Response> => {
		if (url.pathname === PIDECK_PLUGIN_BRIDGE_PATH) {
			return handlePluginBridgeFetch(ctx, {
				method: init?.method,
				// 桥协议 headers 是 Record<string,string>（见 DshFetchMessage）；RequestInit
				// 的 HeadersInit 形状更宽，此处收窄到桥协议形状。body 同理只透传字符串。
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		if (url.pathname === PIDECK_COMMANDS_BRIDGE_PATH) {
			return handleCommandsBridgeFetch(ctx, {
				method: init?.method,
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		// dshmarket 市场路由（方案 A）：/dsh-market/api/v1/* 走 webServer stub 的
		// dispatch（把 fetch 桥请求适配成 node:http 风格后调原路由 handler）。
		if (url.pathname.startsWith("/dsh-market/")) {
			const marketRouter = ctx.get("pideckMarketRouter") as
				| { dispatch?(url: URL, init?: RequestInit): Promise<Response> }
				| undefined;
			if (marketRouter?.dispatch) {
				return marketRouter.dispatch(url, init);
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({ ok: false, error: "market router unavailable" }),
					{ status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
				),
			);
		}
		// connection RPC 通道（方案 B）：/<channel>/<endpoint>（如 /mcp-manager/list）
		// 走 connection stub 的 dispatch——社区插件（dsh-mcp-manager 等）经
		// ctx.connection.rpc.handle 注册的通道都由它分发。
		if (url.pathname.startsWith("/mcp-manager/")) {
			const mcpRouter = ctx.get("pideckMcpRouter") as
				| { dispatch?(url: URL, init?: RequestInit): Promise<Response> }
				| undefined;
			if (mcpRouter?.dispatch) {
				return mcpRouter.dispatch(url, init);
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({ type: "server-response", rpcId: "unknown", result: { ok: false, error: { code: "unavailable", message: "connection stub unavailable" } } }),
					{ status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
				),
			);
		}
		return apiHandler.fetch(url, init);
	};
	console.log(`[dsh-host-entry] boot OK in ${Date.now() - startedAt}ms`);
	port.postMessage({ type: "host-ready" });

	// ── fetch 桥循环：每请求一个 Response，SSE 流逐帧回传 ──
	port.on("message", (message: unknown) => {
		void (async () => {
			// utilityProcess 的 parentPort 消息是 MessageEvent 风格：载荷在 data 字段
			// （{ data: {...}, ports: [...] }）。兼容直接对象两种形状。
			const raw = (message as { data?: unknown } | null)?.data ?? message;
			const msg = raw as Partial<DshFetchMessage>;
			if (msg?.type !== "fetch-request") return;
			const id = msg.id ?? "";
			if (!id) return;
			const url = new URL(msg.path ?? "/", "http://dsh.internal");
			const init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {
				method: msg.method ?? "GET",
				...(msg.headers ? { headers: msg.headers } : {}),
				...(msg.body !== undefined ? { body: msg.body } : {}),
			};
			const controller = new AbortController();
			init.signal = controller.signal;
			// 主进程 abort 转发：取消 host 侧进行中的请求（SSE 流 / 超时）。
			// 注册必须在任何 await 之前（E9）：fetch-abort 是独立消息，若注册晚于
			// handler.fetch 的同步段，先到的 abort 会丢失 → unary 请求无取消路径。
			const onAbortMessage = (abortMessage: unknown) => {
				const abortRaw = (abortMessage as { data?: unknown } | null)?.data ?? abortMessage;
				const parsed = abortRaw as Partial<DshFetchMessage>;
				if (parsed?.type === "fetch-abort" && parsed.id === id) controller.abort();
			};
			port.on("message", onAbortMessage);
			try {
				const response = await handler(url, init);
				const status = response.status;
				const headers: Record<string, string> = {};
				response.headers.forEach((value: string, key: string) => {
					headers[key] = value;
				});
				const isStream = response.body !== null && !(response.headers.get("content-type") ?? "").includes("application/json");
				if (!isStream) {
					const body = await response.text();
					port.postMessage({ type: "fetch-response", id, status, headers, body });
					return;
				}
				port.postMessage({ type: "fetch-stream-start", id, status, headers });
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						port.postMessage({ type: "fetch-chunk", id, data: decoder.decode(value, { stream: true }) });
					}
				} catch (error) {
					port.postMessage({ type: "fetch-error", id, message: String(error) });
					return;
				} finally {
					await reader.cancel().catch(() => undefined);
				}
				port.postMessage({ type: "fetch-end", id });
			} catch (error) {
				port.postMessage({ type: "fetch-error", id, message: String(error) });
			} finally {
				port.off("message", onAbortMessage);
			}
		})();
	});
}

main().catch((error) => {
	console.error("[dsh-host-entry] fatal:", error);
	// 错误经 parentPort 回传主进程（utilityProcess 的 stderr 不可靠），
	// DshHostProcess 收到 host-error 后记入主进程日志。
	try {
		process.parentPort?.postMessage({
			type: "host-error",
			message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
		});
	} catch {
		// parentPort 不可用（ELECTRON_RUN_AS_NODE 等）时只能靠 stderr
	}
	process.exit(1);
});
