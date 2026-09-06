import { useCallback, useEffect, useState } from "react";
import { Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { DshMcpServer } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui-shadcn/select";

const MCP_CHANNEL = "/mcp-manager";

/**
 * MCP 服务器管理面板（方案 B）：经 connection RPC 调 dsh-mcp-manager 的
 * /mcp-manager 通道（list/add/remove/setEnabled/probe）。需要市场里已安装
 * dsh-mcp-manager 插件（host 重启后由 bundle 恢复加载）。
 * 注意：add/remove/setEnabled 写的是 ~/.dsh/profiles/web/cordis.patch.yml
 * （插件默认路径），host 重启后经 include 生效——面板操作后提示重启生效。
 */
export function DshMcpPanel() {
	const [servers, setServers] = useState<DshMcpServer[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [showAdd, setShowAdd] = useState(false);
	const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
	// 添加表单
	const [formId, setFormId] = useState("");
	const [formName, setFormName] = useState("");
	const [formTransport, setFormTransport] = useState<"stdio" | "streamable-http">("streamable-http");
	const [formUrl, setFormUrl] = useState("");
	const [formCommand, setFormCommand] = useState("");
	const [formArgs, setFormArgs] = useState("");
	// 测试结果：serverName → 结果文本
	const [probeResults, setProbeResults] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		setBusy(true);
		try {
			const result = await desktopApi.sessions.mcpRpc({ channel: MCP_CHANNEL, endpoint: "list", payload: undefined }) as {
				ok: boolean;
				value?: { servers?: DshMcpServer[] };
				error?: { message?: string };
			};
			if (result.ok !== true) {
				setLoadError(result.error?.message ?? "mcp manager list failed");
				return;
			}
			setServers(result.value?.servers ?? []);
			setLoadError(null);
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const add = async () => {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(formId.trim())) {
			showNotice(t("config.dsh.mcpInvalidId"), 3000);
			return;
		}
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(formName.trim())) {
			showNotice(t("config.dsh.mcpInvalidName"), 3000);
			return;
		}
		if (formTransport === "streamable-http" && !/^https?:\/\/.+/.test(formUrl.trim())) {
			showNotice(t("config.dsh.mcpInvalidUrl"), 3000);
			return;
		}
		if (formTransport === "stdio" && !formCommand.trim()) {
			showNotice(t("config.dsh.mcpInvalidCommand"), 3000);
			return;
		}
		setBusy(true);
		try {
			const payload = {
				id: formId.trim(),
				config: {
					serverName: formName.trim(),
					transport: formTransport,
					...(formTransport === "streamable-http" ? { url: formUrl.trim() } : { command: formCommand.trim() }),
					...(formTransport === "stdio" && formArgs.trim()
						? { args: formArgs.trim().split(/\s+/).filter(Boolean) }
						: {}),
				},
			};
			const result = await desktopApi.sessions.mcpRpc({ channel: MCP_CHANNEL, endpoint: "add", payload }) as {
				ok: boolean;
				error?: { message?: string };
			};
			if (result.ok !== true) {
				showNotice(result.error?.message ?? t("config.dsh.mcpAddFailed"), 4000);
				return;
			}
			showNotice(t("config.dsh.mcpAddRestartHint"), 4000);
			setShowAdd(false);
			setFormId("");
			setFormName("");
			setFormUrl("");
			setFormCommand("");
			setFormArgs("");
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		if (confirmRemoveId !== id) {
			setConfirmRemoveId(id);
			return;
		}
		setConfirmRemoveId(null);
		setBusy(true);
		try {
			const result = await desktopApi.sessions.mcpRpc({ channel: MCP_CHANNEL, endpoint: "remove", payload: { id } }) as {
				ok: boolean;
				error?: { message?: string };
			};
			if (result.ok !== true) {
				showNotice(result.error?.message ?? t("config.dsh.mcpRemoveFailed"), 4000);
				return;
			}
			showNotice(t("config.dsh.mcpRestartHint"), 3000);
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const setEnabled = async (id: string, enabled: boolean) => {
		setBusy(true);
		try {
			const result = await desktopApi.sessions.mcpRpc({ channel: MCP_CHANNEL, endpoint: "setEnabled", payload: { id, enabled } }) as {
				ok: boolean;
				error?: { message?: string };
			};
			if (result.ok !== true) {
				showNotice(result.error?.message ?? t("config.dsh.mcpToggleFailed"), 4000);
				return;
			}
			showNotice(t("config.dsh.mcpRestartHint"), 3000);
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const probe = async (id: string) => {
		setBusy(true);
		try {
			const result = await desktopApi.sessions.mcpRpc({ channel: MCP_CHANNEL, endpoint: "probe", payload: { id } }) as {
				ok: boolean;
				value?: { ok?: boolean; toolCount?: number; latencyMs?: number; error?: string };
				error?: { message?: string };
			};
			if (result.ok !== true) {
				setProbeResults((prev) => ({ ...prev, [id]: result.error?.message ?? "probe failed" }));
				return;
			}
			const value = result.value ?? {};
			setProbeResults((prev) => ({
				...prev,
				[id]: value.ok === true
					? `${t("config.dsh.mcpProbeOk")}（${value.toolCount ?? 0} tools, ${value.latencyMs ?? "?"}ms）`
					: `${t("config.dsh.mcpProbeFail")}：${value.error ?? "?"}`,
			}));
		} catch (error) {
			setProbeResults((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : String(error) }));
		} finally {
			setBusy(false);
		}
	};

	const transportLabel = (server: DshMcpServer): string =>
		server.transport === "stdio" ? "stdio" : "HTTP";

	return (
		<div className="grid gap-2.5">
			<p className="text-micro text-muted-foreground">{t("config.dsh.mcpHint")}</p>
			<div className="flex items-center gap-2">
				<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => setShowAdd((prev) => !prev)}>
					{showAdd ? <X className="size-3.5" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
					{t("config.dsh.mcpAddServer")}
				</Button>
				<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={busy} onClick={() => void load()}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{showAdd && (
				<div className="grid gap-2 rounded-md border border-border-subtle bg-bg-panel p-2.5">
					<div className="grid gap-1.5">
						<label className="text-micro text-muted-foreground">{t("config.dsh.mcpId")}</label>
						<Input className="h-8" value={formId} onChange={(event) => setFormId(event.currentTarget.value)} placeholder="my-server" />
					</div>
					<div className="grid gap-1.5">
						<label className="text-micro text-muted-foreground">{t("config.dsh.mcpServerName")}</label>
						<Input className="h-8" value={formName} onChange={(event) => setFormName(event.currentTarget.value)} placeholder="MyServer" />
					</div>
					<div className="grid gap-1.5">
						<label className="text-micro text-muted-foreground">{t("config.dsh.mcpTransport")}</label>
						<Select value={formTransport} onValueChange={(value) => setFormTransport(value as "stdio" | "streamable-http")}>
							<SelectTrigger className="h-8">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="streamable-http">streamable-http</SelectItem>
								<SelectItem value="stdio">stdio</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{formTransport === "streamable-http" ? (
						<div className="grid gap-1.5">
							<label className="text-micro text-muted-foreground">{t("config.dsh.mcpUrl")}</label>
							<Input className="h-8" value={formUrl} onChange={(event) => setFormUrl(event.currentTarget.value)} placeholder="https://example.com/mcp" />
						</div>
					) : (
						<>
							<div className="grid gap-1.5">
								<label className="text-micro text-muted-foreground">{t("config.dsh.mcpCommand")}</label>
								<Input className="h-8" value={formCommand} onChange={(event) => setFormCommand(event.currentTarget.value)} placeholder="npx -y @some/mcp-server" />
							</div>
							<div className="grid gap-1.5">
								<label className="text-micro text-muted-foreground">{t("config.dsh.mcpArgs")}</label>
								<Input className="h-8" value={formArgs} onChange={(event) => setFormArgs(event.currentTarget.value)} placeholder="--port 3000" />
							</div>
						</>
					)}
					<div className="flex justify-end">
						<Button type="button" variant="secondary" size="sm" className="h-7" disabled={busy} onClick={() => void add()}>
							{t("config.dsh.mcpAddServer")}
						</Button>
					</div>
				</div>
			)}
			{loadError !== null ? (
				<p className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2 text-micro text-danger">
					{t("config.dsh.mcpUnavailable")}：{loadError}
				</p>
			) : servers.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.mcpEmpty")}</p>
			) : (
				<ul className="grid gap-1.5">
					{servers.map((server) => (
						<li key={server.id} className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground" title={server.id}>
									{server.serverName}
								</span>
								<Badge variant="outline" className="shrink-0 border-border-subtle text-micro text-muted-foreground">
									{transportLabel(server)}
								</Badge>
								<Badge
									variant="outline"
									className={`shrink-0 font-medium ${server.enabled
										? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300"
										: "border-border-subtle text-muted-foreground"}`}
								>
									{server.enabled ? t("config.dsh.mcpEnabled") : t("config.dsh.mcpDisabled")}
								</Badge>
							</div>
							<div className="mt-0.5 flex items-center gap-2 text-micro text-text-secondary">
								<span className="min-w-0 truncate font-mono" title={server.id}>
									{server.id}
								</span>
								<span className="shrink-0">·</span>
								<span className="shrink-0">{server.toolCount} tools</span>
								{server.fiberPhase != null && (
									<>
										<span className="shrink-0">·</span>
										<span className="shrink-0">{server.fiberPhase}</span>
									</>
								)}
							</div>
							{probeResults[server.id] && (
								<p className="mt-1 truncate text-micro text-text-secondary" title={probeResults[server.id]}>
									{probeResults[server.id]}
								</p>
							)}
							<div className="mt-1.5 flex items-center gap-1.5">
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy} onClick={() => void probe(server.id)}>
									<Play className="size-3" aria-hidden="true" />
									{t("config.dsh.mcpProbe")}
								</Button>
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy} onClick={() => void setEnabled(server.id, !server.enabled)}>
									{server.enabled ? t("config.dsh.mcpDisable") : t("config.dsh.mcpEnable")}
								</Button>
								<Button
									type="button"
									variant={confirmRemoveId === server.id ? "destructive" : "ghost"}
									size="sm"
									className="h-6 text-muted-foreground"
									disabled={busy}
									onClick={() => void remove(server.id)}
								>
									<Trash2 className="size-3" aria-hidden="true" />
									{t(confirmRemoveId === server.id ? "config.dsh.mcpConfirmRemove" : "config.dsh.mcpRemove")}
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
