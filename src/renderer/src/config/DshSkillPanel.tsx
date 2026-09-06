import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { DshSkillDetail, DshSkillSummary } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { CodeMirrorEditor } from "../components/app/CodeMirrorEditor";

/** 技能名语法（与 dsh 生态 isSkillName 一致：kebab-case）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type EditorMode = { kind: "create" } | { kind: "edit"; name: string };

/**
 * DSH 技能管理面板：用户级 ~/.dsh/skills/ 的 SKILL.md CRUD。
 * host 用 chokidar 监听目录——保存后目录实时刷新，composer /name 立即可用。
 */
export function DshSkillPanel() {
	const [skills, setSkills] = useState<DshSkillSummary[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [editor, setEditor] = useState<EditorMode | null>(null);
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [confirmRemoveName, setConfirmRemoveName] = useState<string | null>(null);
	// 编辑器表单
	const [formName, setFormName] = useState("");
	const [formDescription, setFormDescription] = useState("");
	const [formWhenToUse, setFormWhenToUse] = useState("");
	const [formContent, setFormContent] = useState("");

	const load = useCallback(async () => {
		setBusy(true);
		try {
			const result = await desktopApi.sessions.skillList();
			setSkills(result);
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

	const openCreate = () => {
		setEditor({ kind: "create" });
		setFormName("");
		setFormDescription("");
		setFormWhenToUse("");
		setFormContent("");
	};

	const openEdit = async (name: string) => {
		setEditor({ kind: "edit", name });
		setLoadingDetail(true);
		try {
			const detail = await desktopApi.sessions.skillRead(name);
			if (detail === null) {
				showNotice(t("config.dsh.skillNotFound"), 3000);
				setEditor(null);
				return;
			}
			setFormName(detail.name);
			setFormDescription(detail.description);
			setFormWhenToUse(detail.whenToUse ?? "");
			setFormContent(detail.content);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3000);
			setEditor(null);
		} finally {
			setLoadingDetail(false);
		}
	};

	const closeEditor = () => {
		setEditor(null);
		setConfirmRemoveName(null);
	};

	const save = async () => {
		const name = formName.trim();
		if (!SKILL_NAME_RE.test(name)) {
			showNotice(t("config.dsh.skillInvalidName"), 3000);
			return;
		}
		if (!formDescription.trim()) {
			showNotice(t("config.dsh.skillInvalidDescription"), 3000);
			return;
		}
		const payload = {
			name,
			description: formDescription.trim(),
			...(formWhenToUse.trim() ? { whenToUse: formWhenToUse.trim() } : {}),
			content: formContent,
		};
		setBusy(true);
		try {
			if (editor?.kind === "create") {
				await desktopApi.sessions.skillCreate(payload);
				showNotice(t("config.dsh.skillCreated"), 3000);
			} else if (editor?.kind === "edit") {
				await desktopApi.sessions.skillUpdate(editor.name, payload);
				showNotice(t("config.dsh.skillUpdated"), 3000);
			}
			closeEditor();
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (name: string) => {
		if (confirmRemoveName !== name) {
			setConfirmRemoveName(name);
			return;
		}
		setConfirmRemoveName(null);
		setBusy(true);
		try {
			await desktopApi.sessions.skillDelete(name);
			showNotice(t("config.dsh.skillRemoved"), 3000);
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	if (editor !== null) {
		return (
			<div className="grid gap-2.5">
				<div className="flex items-center gap-2">
					<h3 className="text-caption font-semibold text-foreground">
						{t(editor.kind === "create" ? "config.dsh.skillCreateTitle" : "config.dsh.skillEditTitle")}
					</h3>
					<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={closeEditor}>
						<X className="size-3.5" aria-hidden="true" />
						{t("common.cancel")}
					</Button>
				</div>
				<div className="grid gap-1.5">
					<label className="text-micro text-muted-foreground">{t("config.dsh.skillName")}</label>
					<Input
						className="h-8"
						value={formName}
						disabled={editor.kind === "edit"}
						onChange={(event) => setFormName(event.currentTarget.value)}
						placeholder="my-skill"
					/>
					{editor.kind === "edit" && <p className="text-micro text-text-secondary">{t("config.dsh.skillNameReadonlyHint")}</p>}
				</div>
				<div className="grid gap-1.5">
					<label className="text-micro text-muted-foreground">{t("config.dsh.skillDescription")}</label>
					<Input className="h-8" value={formDescription} onChange={(event) => setFormDescription(event.currentTarget.value)} placeholder="技能做什么" />
				</div>
				<div className="grid gap-1.5">
					<label className="text-micro text-muted-foreground">{t("config.dsh.skillWhenToUse")}</label>
					<Input className="h-8" value={formWhenToUse} onChange={(event) => setFormWhenToUse(event.currentTarget.value)} placeholder="何时使用（可选）" />
				</div>
				<div className="grid gap-1.5">
					<label className="text-micro text-muted-foreground">{t("config.dsh.skillContent")}</label>
					{loadingDetail ? (
						<div className="flex h-48 items-center justify-center text-control text-muted-foreground">{t("common.loading")}</div>
					) : (
						<CodeMirrorEditor
							value={formContent}
							language="markdown"
							height="240px"
							onChange={(value) => setFormContent(value)}
						/>
					)}
				</div>
				<div className="flex justify-end">
					<Button type="button" variant="secondary" size="sm" className="h-7" disabled={busy || loadingDetail} onClick={() => void save()}>
						{t("common.save")}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="grid gap-2.5">
			<p className="text-micro text-muted-foreground">{t("config.dsh.skillHint")}</p>
			<div className="flex items-center gap-2">
				<Button type="button" variant="secondary" size="sm" className="h-7" onClick={openCreate}>
					<Plus className="size-3.5" aria-hidden="true" />
					{t("config.dsh.skillCreate")}
				</Button>
				<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={busy} onClick={() => void load()}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{loadError !== null ? (
				<p className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2 text-micro text-danger">{loadError}</p>
			) : skills.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.skillEmpty")}</p>
			) : (
				<ul className="grid gap-1.5">
					{skills.map((skill) => (
						<li key={skill.name} className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground" title={skill.path}>
									{skill.name}
								</span>
								<Button type="button" variant="ghost" size="sm" className="h-6 text-muted-foreground" onClick={() => void openEdit(skill.name)}>
									<Pencil className="size-3" aria-hidden="true" />
									{t("config.dsh.skillEdit")}
								</Button>
								<Button
									type="button"
									variant={confirmRemoveName === skill.name ? "destructive" : "ghost"}
									size="sm"
									className="h-6 text-muted-foreground"
									disabled={busy}
									onClick={() => void remove(skill.name)}
								>
									<Trash2 className="size-3" aria-hidden="true" />
									{t(confirmRemoveName === skill.name ? "config.dsh.skillConfirmRemove" : "config.dsh.skillRemove")}
								</Button>
							</div>
							<p className="mt-0.5 line-clamp-2 text-micro text-text-secondary">{skill.description}</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
