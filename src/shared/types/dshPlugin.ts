/**
 * DSH 动态 Cordis 插件管理（G13 深化）的跨进程契约类型。
 * 与 src/main/dsh/pideckPluginBridge.ts 的视图/入参形状一一对应。
 */

/** 动态插件清单行（inventory 的安全 JSON 视图）。 */
export type DshPluginView = {
	pluginId: string;
	/** 归属会话（DSH host 的 sessionId，与 catalog 的 dshSessionId 对照）。 */
	agentId: string;
	packages: Array<{
		packageId: string;
		name: string;
		purpose: string;
		hasHostHalf: boolean;
		hasClientHalf: boolean;
	}>;
	currentPackageId?: string;
	nextPackageId?: string;
	activeRun?: { pluginRunId: string; packageId: string };
	status?: string;
	mode?: string;
	error?: string;
};

/** 静态 Loader 条目视图（pluginInventory 的安全 JSON 视图，只读）。 */
export type DshStaticPluginView = {
	entryId: string;
	moduleName: string;
	enabled: boolean;
	fiberPhase: string | null;
};

/** 安装（define）入参。 */
export type DshPluginInstallInput = {
	sessionId: string;
	/** 3-6 个小写英文字母语义前缀；host 分配最终 pluginId。 */
	idPrefix: string;
	name: string;
	purpose: string;
	hostCode?: string;
	clientCode?: string;
};

/** 生命周期操作入参（run/stop/uninstall）。 */
export type DshPluginLifecycleInput = {
	sessionId: string;
	pluginId: string;
	packageId?: string;
	mode?: "run" | "update";
};

/** 桥 RPC 响应（主进程 rawFetch 解析用；{ ok:false } 时主进程抛 error 文本）。 */
export type DshPluginBridgeResponse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 会话命令枚举桥（D15）的跨进程契约类型：host 侧 `ctx.commands.list(agent)`
 * 的 CommandDescriptor 安全 JSON 视图（pideck-command-bridge 服务）。
 */
export type DshCommandView = {
	/** 命令名（不带前导斜杠的小写名；Composer `/` 补全用）。 */
	name: string;
	/** 命令描述（host 注册表原文，`CommandDescriptor.description`）。 */
	description: string;
	/** 可选自由输入占位提示（`CommandDescriptor.input.hint`）。 */
	inputHint?: string;
};

/**
 * DSH 技能目录行（G7）：wire `skill.list` 的 SkillEntry 安全 JSON 视图。
 * 技能经 composer 的 `/name` 斜杠调用（dsh-tool-skill 在 pre-step 注入正文），
 * 本目录只做只读呈现，不做管理。
 */
export type DshSkillView = {
	/** Kebab-case 标识（composer 以 /name 引用）。 */
	name: string;
	/** 简短路由描述。 */
	description: string;
	/** 可选额外路由指导。 */
	whenToUse?: string;
	/** false = 用户专用技能（disable-model-invocation）：模型目录不可见、仅用户可调用。 */
	modelInvocable: boolean;
};

/**
 * dshmarket 市场契约（方案 A）。主进程 IPC 直接透传 dshmarket 路由的 JSON 响应，
 * 这里只定义 renderer 用得到的窄视图（宽松字段，未知字段不拦截）。
 */

/** 市场目录条目（curated registry 快照：awesome-dsh-plugin 精选来源）。
 *  description 为 { en, zh } 双语对象（渲染层按当前语言取值）。 */
export type DshMarketPluginEntry = {
	name: string;
	url: string;
	owner?: string;
	/** 分类 id（如 "agi" / "ui"）。 */
	category?: string;
	description?: string | { en?: string; zh?: string };
	/** npm 包名（无则 null/缺省——GitHub 源插件）。 */
	npm?: string | null;
	version?: string | null;
	stars?: number;
	downloads?: number | null;
	install?: string;
	added?: string;
};

/** 市场目录响应（GET /dsh-market/registry → { registry }）。 */
export type DshMarketCatalog = {
	registry: {
		name: string;
		url: string;
		updated?: string;
		count: number;
		plugins: DshMarketPluginEntry[];
	};
};

/** 已装插件响应（GET /dsh-market/installed → { profile, installed, ... }）。
 *  注意：installed 的 key 是 npm 全名（@scope/name），registry 条目的 name 是
 *  短名（dsh-mcp-toggle）——渲染层匹配要兼容 `@scope/name`。 */
export type DshMarketInstalled = {
	profile: string;
	/** name → spec（package.json dependencies 形状；key 为 npm 全名）。 */
	installed: Record<string, string>;
	/** 已落盘安装的 npm 全名列表。 */
	present?: string[];
	/** 激活状态（key 为 npm 全名；state: live/disabled 等）。 */
	activation?: Record<string, { state?: string; bundle?: boolean; hot?: boolean }>;
	/** 当前 live（已激活）的插件名。 */
	live: string[];
	disabled: string[];
};

/** 安装/卸载响应（POST /dsh-market/install | /dsh-market/uninstall）。 */
export type DshMarketMutationResult = {
	ok: boolean;
	hot?: boolean;
	exitCode?: number;
	error?: string;
	activation?: Record<string, unknown>;
};

/** 安装进度状态（GET /dsh-market/status）。 */
export type DshMarketStatus = {
	active: boolean;
	target: string;
	seconds: number;
	phase: string | null;
	/** pnpm/安装器最后一行输出（进度展示用）。 */
	lastLine?: string;
	done: number;
	total: number | null;
	error: string | null;
	busy: boolean;
	pnpm: boolean;
};

/**
 * MCP 服务器条目（方案 B：dsh-mcp-manager 的 /mcp-manager list 返回）。
 * 渲染层面板直接消费该形状。
 */
export type DshMcpServer = {
	id: string;
	serverName: string;
	transport: "stdio" | "streamable-http";
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	enabled: boolean;
	fiberPhase?: string | null;
	toolCount: number;
	userManaged: boolean;
};

/** MCP RPC 入参（方案 B：channel + endpoint + payload）。 */
export type DshMcpRpcInput = {
	channel: string;
	endpoint: string;
	payload?: unknown;
};
