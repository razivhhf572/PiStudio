/**
 * DSH 技能管理（用户级 ~/.dsh/skills/ 的 SKILL.md CRUD）。
 *
 * 与 dsh-skill-filesystem（host 侧只读 provider）同一目录约定：
 *   $DSH_HOME/skills/<name>/SKILL.md（目录形态，支持技能携带资源文件）
 * 格式：YAML frontmatter（name/description 必填、whenToUse 可选）+ Markdown body，
 * 与 dsh 生态 parseSkillFile 的解析规则一致（name 需匹配 kebab-case）。
 *
 * host 用 chokidar 监听该目录——写文件即被感知，目录实时刷新，无需重启；
 * composer `/name` 斜杠调用立即可用。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { DshSkillDetail, DshSkillSummary, DshSkillUpsertInput } from "../../shared/types";

/** dsh 生态技能名语法（@deepseek-ai/dsh-skill isSkillName 同款）。 */
export const DSH_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 解析 SKILL.md：frontmatter + body；格式非法返回 null（与 host 忽略逻辑一致）。 */
export function parseDshSkillFile(raw: string): Omit<DshSkillDetail, "path"> | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (match === null) return null;
	let data: Record<string, unknown>;
	try {
		const loaded = yaml.load(match[1]);
		data = typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
	} catch {
		return null;
	}
	const name = typeof data.name === "string" ? data.name : "";
	const description = typeof data.description === "string" ? data.description : "";
	if (name === "" || description === "" || !DSH_SKILL_NAME_RE.test(name)) return null;
	return {
		name,
		description,
		...(typeof data.whenToUse === "string" && data.whenToUse.trim() !== "" ? { whenToUse: data.whenToUse.trim() } : {}),
		content: (match[2] ?? "").trim(),
	};
}

/** 生成 SKILL.md（frontmatter 保持 host 解析器接受的形状）。 */
export function renderDshSkillFile(input: DshSkillUpsertInput): string {
	const frontmatter: Record<string, string> = { name: input.name, description: input.description.trim() };
	if (input.whenToUse !== undefined && input.whenToUse.trim() !== "") frontmatter.whenToUse = input.whenToUse.trim();
	const body = input.content.trim();
	return `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n${body === "" ? "\n" : `\n${body}\n`}`;
}

/**
 * 用户级 DSH 技能目录管理器（只管理 $DSH_HOME/skills/，不碰项目级
 * .dsh/skills 与 .agents/skills——避免误删项目资产，与 pi SkillManager 同策略）。
 */
export class DshSkillManager {
	private readonly dshHome: () => string;

	constructor(dshHome: () => string) {
		this.dshHome = dshHome;
	}

	private get dir(): string {
		return join(this.dshHome(), "skills");
	}

	private skillDir(name: string): string {
		return join(this.dir, name);
	}

	/** 目录技能（<name>/SKILL.md）清单（目录形式，与 PiStudio 自带技能同形态）。 */
	list(): DshSkillSummary[] {
		if (!existsSync(this.dir)) return [];
		const result: DshSkillSummary[] = [];
		for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
			const candidate = join(this.dir, entry.name);
			const file = entry.isDirectory() ? join(candidate, "SKILL.md") : entry.isFile() && entry.name.endsWith(".md") ? candidate : undefined;
			if (file === undefined || !existsSync(file)) continue;
			const parsed = parseDshSkillFile(readFileSync(file, "utf8"));
			if (parsed === null) continue;
			result.push({
				name: parsed.name,
				description: parsed.description,
				...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
				path: file,
			});
		}
		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 读取单个技能全文；不存在/格式非法返回 null。 */
	read(name: string): DshSkillDetail | null {
		if (!DSH_SKILL_NAME_RE.test(name)) return null;
		const file = join(this.skillDir(name), "SKILL.md");
		if (!existsSync(file)) return null;
		const parsed = parseDshSkillFile(readFileSync(file, "utf8"));
		if (parsed === null) return null;
		return { ...parsed, path: file };
	}

	/** 新建技能（目录形态）；name 已存在抛错。 */
	create(input: DshSkillUpsertInput): void {
		if (!DSH_SKILL_NAME_RE.test(input.name)) {
			throw new Error(`invalid skill name "${input.name}" (kebab-case: a-z0-9 and hyphens)`);
		}
		const dir = this.skillDir(input.name);
		if (existsSync(dir)) {
			throw new Error(`skill "${input.name}" already exists`);
		}
		mkdirSync(this.dir, { recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), renderDshSkillFile(input), "utf8");
	}

	/** 更新技能内容；不存在抛错。 */
	update(name: string, input: DshSkillUpsertInput): void {
		if (!DSH_SKILL_NAME_RE.test(name)) {
			throw new Error(`invalid skill name "${name}" (kebab-case: a-z0-9 and hyphens)`);
		}
		const dir = this.skillDir(name);
		if (!existsSync(dir)) {
			throw new Error(`skill "${name}" does not exist`);
		}
		writeFileSync(join(dir, "SKILL.md"), renderDshSkillFile(input), "utf8");
	}

	/** 删除技能（整个目录）；不存在时静默。 */
	remove(name: string): void {
		if (!DSH_SKILL_NAME_RE.test(name)) return;
		const dir = this.skillDir(name);
		if (!existsSync(dir)) return;
		rmSync(dir, { recursive: true, force: true });
	}
}
