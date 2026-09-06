import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search, Trash2 } from "lucide-react";
import type { DshMarketCatalog, DshMarketInstalled, DshMarketMutationResult, DshMarketPluginEntry, DshMarketStatus } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { getI18nLocale, t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Pagination } from "../components/ui-shadcn/pagination";

/** 市场目录每页行数（与静态清单一致）。 */
const MARKET_PAGE_SIZE = 20;

/** 安装进度轮询间隔（ms）。 */
const STATUS_POLL_MS = 1000;
/** 安装进度轮询上限（安装超过 5 分钟视为失败/超时，交回用户手动刷新）。 */
const STATUS_POLL_LIMIT = 300;

/**
 * registry 的 description/分类等字段是 { en, zh } 双语对象（awesome-dsh-plugin
 * 格式）；统一取当前语言，缺失时回退另一种语言，再回退空串。
 */
function locText(value: string | { en?: string; zh?: string } | null | undefined): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	const locale = getI18nLocale();
	if (locale === "zh-CN") return value.zh ?? value.en ?? "";
	return value.en ?? value.zh ?? "";
}

/** 来源短名：npm: → npm，github: → GitHub，其余按条目 npm 字段判断。 */
function sourceShort(plugin: DshMarketPluginEntry): string {
	const url = plugin.url ?? "";
	if (url.startsWith("npm:")) return "npm";
	if (url.startsWith("github:")) return "GitHub";
	if (url.startsWith("file:")) return "file";
	if (url.includes("github.com")) return "GitHub";
	if (plugin.npm) return "npm";
	return "npm";
}

/**
 * 插件市场视图（方案 A）：dshmarket 的 curated registry 目录（awesome-dsh-plugin
 * 精选来源，3158+ 插件）。列表 = 搜索 + 分页；每行显示名称/描述/来源/已装状态，
 * 安装走 POST /dsh-market/install（url 必须在精选目录内），期间轮询 status 显示进度，
 * 成功后插件热加载（无需重启 host）。卸载按插件名两步确认。
 */
export function PluginMarketView() {
	const [catalog, setCatalog] = useState<DshMarketCatalog | null>(null);
	const [installed, setInstalled] = useState<DshMarketInstalled | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	/** host settings 命名空间（describeDshSettings）；null = 未拉到（不标注）。 */
	const [settingsNamespaces, setSettingsNamespaces] = useState<string[] | null>(null);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);
	/** 市场视图：全部插件 / 已安装。 */
	const [view, setView] = useState<"all" | "installed">("all");
	const [busy, setBusy] = useState(false);
	/** 正在安装的插件名（显示进度行）。 */
	const [installingName, setInstallingName] = useState<string | null>(null);
	/** 安装进度（status 轮询快照）。 */
	const [status, setStatus] = useState<DshMarketStatus | null>(null);
	/** 两步确认卸载的插件名。 */
	const [confirmUninstallName, setConfirmUninstallName] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [catalogResult, installedResult] = await Promise.all([
				desktopApi.sessions.marketCatalog(),
				desktopApi.sessions.marketInstalled(),
			]);
			setCatalog(catalogResult);
			setInstalled(installedResult);
			setLoadError(null);
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
		// 插件配置命名空间（「插件配置」tab 的呈现依据）——拉不到就保持 null（不标注）。
		try {
			const settingsResult = await desktopApi.sessions.describeDshSettings();
			setSettingsNamespaces((settingsResult?.namespaces ?? []).map((ns) => ns.ns));
		} catch {
			setSettingsNamespaces(null);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const plugins = useMemo(() => catalog?.registry?.plugins ?? [], [catalog]);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered = useMemo(
		() =>
			plugins.filter((plugin) => {
				if (normalizedQuery.length === 0) return true;
				return [plugin.name, locText(plugin.description)].some((value) =>
					value.toLocaleLowerCase().includes(normalizedQuery),
				);
			}),
		[plugins, normalizedQuery],
	);

	/** 已装插件的 npm 全名（installed 的 key 兼容 registry 短名）。 */
	const installedNameFor = (name: string): string | null => {
		const record = installed?.installed ?? {};
		const keys = Object.keys(record);
		if (keys.length === 0) return null;
		return keys.find((key) => key === name || key.endsWith(`/${name}`)) ?? null;
	};
	const isInstalled = (name: string): boolean => installedNameFor(name) !== null;
	const isLive = (name: string): boolean => {
		const fullName = installedNameFor(name);
		if (fullName !== null) {
			const activation = installed?.activation?.[fullName];
			if (activation?.state === "live") return true;
		}
		const live = installed?.live ?? [];
		return live.includes(name) || live.some((item) => item.endsWith(`/${name}`));
	};

	/** 安装：并发轮询 status 显示进度（不等 IPC 返回，装完才收敛），刷新已装。 */
	const install = async (plugin: { name: string; url: string }) => {
		if (busy) {
			showNotice(t("config.dsh.marketBusyOther"), 3000);
			return;
		}
		setBusy(true);
		setInstallingName(plugin.name);
		setStatus(null);
		try {
			// IPC 会阻塞到安装完成，进度必须并发轮询——轮询直到 install 落定。
			const installPromise = desktopApi.sessions.marketInstall(plugin.url) as Promise<DshMarketMutationResult>;
			let settled = false;
			void installPromise.finally(() => {
				settled = true;
			});
			let attempts = 0;
			while (!settled && attempts < STATUS_POLL_LIMIT) {
				attempts += 1;
				await new Promise((resolvePromise) => setTimeout(resolvePromise, STATUS_POLL_MS));
				try {
					const snapshot = await desktopApi.sessions.marketStatus() as DshMarketStatus;
					setStatus(snapshot);
				} catch {
					break;
				}
			}
			const result = await installPromise;
			if (result.ok !== true) {
				showNotice(result.error ?? t("config.dsh.marketInstallFailed"), 4000);
				return;
			}
			showNotice(t("config.dsh.marketInstalledToast"), 3000);
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
			setInstallingName(null);
			setStatus(null);
		}
	};

	/** 卸载：两步确认（第一次点击进入确认态，第二次执行）。 */
	const uninstall = async (name: string) => {
		if (confirmUninstallName !== name) {
			setConfirmUninstallName(name);
			return;
		}
		setConfirmUninstallName(null);
		setBusy(true);
		try {
			const result = await desktopApi.sessions.marketUninstall(name) as DshMarketMutationResult;
			if (result.ok !== true) {
				showNotice(result.error ?? t("config.dsh.marketUninstallFailed"), 4000);
				return;
			}
			showNotice(t("config.dsh.marketUninstalledToast"), 3000);
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const totalPages = Math.max(1, Math.ceil(filtered.length / MARKET_PAGE_SIZE));
	const pageClamped = Math.min(page, totalPages);
	const pageRows = filtered.slice((pageClamped - 1) * MARKET_PAGE_SIZE, pageClamped * MARKET_PAGE_SIZE);

	/** 已安装列表（npm 全名 → spec + 激活状态），按激活优先排序。 */
	const installedRows = useMemo(() => {
		const record = installed?.installed ?? {};
		const activation = installed?.activation ?? {};
		return Object.entries(record)
			.map(([name, spec]) => ({
				name,
				spec,
				state: activation[name]?.state ?? (isLive(name) ? "live" : "installed"),
			}))
			.sort((a, b) => (a.state === "live" ? -1 : 1) - (b.state === "live" ? -1 : 1));
	}, [installed, isLive]);

	/** 已安装视图的搜索过滤。 */
	const filteredInstalled = useMemo(() => {
		if (normalizedQuery.length === 0) return installedRows;
		return installedRows.filter((row) => row.name.toLocaleLowerCase().includes(normalizedQuery));
	}, [installedRows, normalizedQuery]);

	/**
	 * 插件是否有设置界面：host settings 命名空间里存在该插件的短名。
	 * settings namespace 即插件短名（kebab-case），匹配 npm 全名/去 scope 名/
	 * 去 dsh- 前缀名；拉不到命名空间（null）时不标注。
	 */
	const hasSettings = (name: string): boolean => {
		if (settingsNamespaces === null) return true; // 未知：不标「无设置」
		const short = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
		const candidates = new Set([name, short, short.replace(/^dsh-/, "")]);
		return settingsNamespaces.some((ns) => candidates.has(ns));
	};

	return (
		<div className="grid gap-2.5">
			<p className="text-micro text-muted-foreground">{t("config.dsh.marketHint")}</p>
			{/* 子 tab：全部插件 / 已安装 */}
			<div className="flex items-center gap-4 border-b border-border/60 px-1">
				{(
					[
						{ id: "all", labelKey: "config.dsh.marketTabAll" },
						{ id: "installed", labelKey: "config.dsh.marketTabInstalled" },
					] as const
				).map((pane) => (
					<button
						key={pane.id}
						type="button"
						className={`-mb-px border-b-2 pb-2 pt-1 text-caption font-medium transition-colors ${
							view === pane.id
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
						onClick={() => setView(pane.id)}
					>
						{t(pane.labelKey)}
					</button>
				))}
			</div>
			<label className="relative block">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input
					type="search"
					value={query}
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						setPage(1);
					}}
					placeholder={t("config.dsh.marketSearchPlaceholder")}
					className="h-9 pl-8"
				/>
			</label>
			<div className="flex items-baseline gap-2 px-0.5">
				<h3 className="text-caption font-semibold text-foreground">{t("config.dsh.tab.pluginMarket")}</h3>
				<span className="text-micro tabular-nums text-muted-foreground">
					{view === "installed" ? installedRows.length : catalog?.registry?.count != null ? filtered.length : 0}
				</span>
				<Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-muted-foreground" disabled={busy} onClick={() => void load()}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{view === "installed" ? (
				loadError !== null ? (
					<p className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2 text-micro text-danger">
						{t("config.dsh.marketUnavailable")}：{loadError}
					</p>
				) : installedRows.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.marketInstalledEmpty")}</p>
				) : filteredInstalled.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.pluginNoMatch")}</p>
				) : (
					<ul className="grid gap-1.5">
						{filteredInstalled.map((row) => (
							<li key={row.name} className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground" title={row.name}>
										{row.name}
									</span>
									<Badge
										variant="outline"
										className={`shrink-0 font-medium ${row.state === "live"
											? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300"
											: "border-border-subtle text-muted-foreground"}`}
									>
										{row.state === "live" ? t("config.dsh.marketLive") : t("config.dsh.marketInstalled")}
									</Badge>
									{settingsNamespaces !== null && !hasSettings(row.name) && (
										<Badge variant="outline" className="shrink-0 border-border-subtle text-micro text-muted-foreground" title={t("config.dsh.marketNoSettingsHint")}>
											{t("config.dsh.marketNoSettings")}
										</Badge>
									)}
								</div>
								<div className="mt-0.5 min-w-0 truncate font-mono text-micro text-text-secondary" title={row.spec}>
									{row.spec}
								</div>
								<div className="mt-1.5 flex items-center gap-1.5">
									<Button
										type="button"
										variant={confirmUninstallName === row.name ? "destructive" : "ghost"}
										size="sm"
										className="h-6 text-muted-foreground"
										disabled={busy}
										onClick={() => void uninstall(row.name)}
									>
										<Trash2 className="size-3" aria-hidden="true" />
										{t(confirmUninstallName === row.name ? "config.dsh.marketConfirmUninstall" : "config.dsh.marketUninstall")}
									</Button>
								</div>
							</li>
						))}
					</ul>
				)
			) : loading && plugins.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.marketLoading")}</p>
			) : loadError !== null ? (
				<p className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2 text-micro text-danger">
					{t("config.dsh.marketUnavailable")}：{loadError}
				</p>
			) : plugins.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.marketEmpty")}</p>
			) : filtered.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.pluginNoMatch")}</p>
			) : (
				<ul className="grid gap-1.5">
					{pageRows.map((plugin) => {
						const installedNow = isInstalled(plugin.name);
						const liveNow = isLive(plugin.name);
						const installingNow = installingName === plugin.name;
						return (
							<li key={plugin.url} className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground" title={plugin.name}>
										{plugin.name}
									</span>
									<Badge variant="outline" className="shrink-0 border-border-subtle text-micro text-muted-foreground">
										{sourceShort(plugin)}
									</Badge>
									{installedNow ? (
										<Badge
											variant="outline"
											className={`shrink-0 border-micro font-medium ${liveNow
												? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300"
												: "border-border-subtle text-muted-foreground"}`}
										>
											{liveNow ? t("config.dsh.marketLive") : t("config.dsh.marketInstalled")}
										</Badge>
									) : null}
								</div>
								{locText(plugin.description) ? (
									<p className="mt-0.5 line-clamp-2 text-caption text-text-secondary">{locText(plugin.description)}</p>
								) : null}
								<div className="mt-1.5 flex items-center gap-1.5">
									{installedNow ? (
										<Button
											type="button"
											variant={confirmUninstallName === plugin.name ? "destructive" : "ghost"}
											size="sm"
											className="h-6 text-muted-foreground"
											disabled={busy}
											onClick={() => void uninstall(plugin.name)}
										>
											<Trash2 className="size-3" aria-hidden="true" />
											{t(confirmUninstallName === plugin.name ? "config.dsh.marketConfirmUninstall" : "config.dsh.marketUninstall")}
										</Button>
									) : (
										<Button
											type="button"
											variant="secondary"
											size="sm"
											className="h-6"
											disabled={installingNow}
											onClick={() => void install(plugin)}
										>
											<Download className="size-3" aria-hidden="true" />
											{t("config.dsh.marketInstall")}
										</Button>
									)}
									{installingNow && status !== null && (
										<span className="min-w-0 truncate text-micro text-muted-foreground" title={status.lastLine ?? undefined}>
											{t("config.dsh.marketInstalling")}
											{status.phase ? ` · ${status.phase}` : ""}
											{status.total != null && status.total > 0 ? ` · ${status.done}/${status.total}` : ""}
										</span>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{view === "all" && totalPages > 1 && (
				<Pagination page={pageClamped} totalPages={totalPages} onPageChange={setPage} className="py-1" />
			)}
		</div>
	);
}
