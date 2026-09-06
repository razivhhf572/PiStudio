/**
 * DSH 技能管理器单测（dshSkillManager.ts）：
 * - parseDshSkillFile：frontmatter 解析（合法/非法/缺失字段/非法 name）
 * - renderDshSkillFile：生成文件可被 parse 回读
 * - DshSkillManager CRUD：临时 home 下 create/read/list/update/remove
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DSH_SKILL_NAME_RE,
	parseDshSkillFile,
	renderDshSkillFile,
	DshSkillManager,
} from "../src/main/dsh/dshSkillManager.ts";

test("skill name grammar: kebab-case only", () => {
	assert.equal(DSH_SKILL_NAME_RE.test("my-skill"), true);
	assert.equal(DSH_SKILL_NAME_RE.test("a1-b2"), true);
	assert.equal(DSH_SKILL_NAME_RE.test("MySkill"), false);
	assert.equal(DSH_SKILL_NAME_RE.test("my_skill"), false);
	assert.equal(DSH_SKILL_NAME_RE.test("my skill"), false);
	assert.equal(DSH_SKILL_NAME_RE.test("-lead"), false);
	assert.equal(DSH_SKILL_NAME_RE.test("trail-"), false);
	assert.equal(DSH_SKILL_NAME_RE.test(""), false);
});

test("parseDshSkillFile: valid frontmatter", () => {
	const raw = "---\nname: my-skill\ndescription: 做一件事\nwhenToUse: 需要时\n---\n\n正文内容\n第二行\n";
	const parsed = parseDshSkillFile(raw);
	assert.ok(parsed !== null);
	assert.equal(parsed.name, "my-skill");
	assert.equal(parsed.description, "做一件事");
	assert.equal(parsed.whenToUse, "需要时");
	assert.equal(parsed.content, "正文内容\n第二行");
});

test("parseDshSkillFile: rejects missing frontmatter / required fields / invalid name", () => {
	assert.equal(parseDshSkillFile("no frontmatter here"), null);
	assert.equal(parseDshSkillFile("---\nname: only-name\n---\nbody"), null); // 缺 description
	assert.equal(parseDshSkillFile("---\ndescription: only-desc\n---\nbody"), null); // 缺 name
	assert.equal(parseDshSkillFile("---\nname: Bad Name\ndescription: x\n---\nbody"), null); // 非法 name
	assert.equal(parseDshSkillFile("---\nname: [not-a-string]\ndescription: x\n---\nbody"), null);
});

test("renderDshSkillFile: output round-trips through parse", () => {
	const rendered = renderDshSkillFile({ name: "round-trip", description: "描述", whenToUse: "场景", content: "body line" });
	const parsed = parseDshSkillFile(rendered);
	assert.ok(parsed !== null);
	assert.equal(parsed.name, "round-trip");
	assert.equal(parsed.description, "描述");
	assert.equal(parsed.whenToUse, "场景");
	assert.equal(parsed.content, "body line");
});

test("DshSkillManager: create → list → read → update → remove", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-skill-test-"));
	try {
		const manager = new DshSkillManager(() => home);

		// 初始为空
		assert.deepEqual(manager.list(), []);
		assert.equal(manager.read("nonexistent"), null);

		// create
		manager.create({ name: "alpha-skill", description: "第一个技能", whenToUse: "场景A", content: "# Alpha\n\n正文" });
		assert.equal(existsSync(join(home, "skills", "alpha-skill", "SKILL.md")), true);

		// 重复 create 抛错
		assert.throws(() => manager.create({ name: "alpha-skill", description: "x", content: "" }), /already exists/);

		// list
		const listed = manager.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "alpha-skill");
		assert.equal(listed[0].description, "第一个技能");
		assert.equal(listed[0].whenToUse, "场景A");
		assert.ok(listed[0].path.replaceAll("\\", "/").endsWith("alpha-skill/SKILL.md"));

		// read
		const detail = manager.read("alpha-skill");
		assert.ok(detail !== null);
		assert.equal(detail.content, "# Alpha\n\n正文");
		assert.equal(detail.whenToUse, "场景A");

		// update（不传 whenToUse 时清掉）
		manager.update("alpha-skill", { name: "alpha-skill", description: "更新后的描述", content: "新正文" });
		const updated = manager.read("alpha-skill");
		assert.ok(updated !== null);
		assert.equal(updated.description, "更新后的描述");
		assert.equal(updated.whenToUse, undefined);
		assert.equal(updated.content, "新正文");

		// update 不存在的技能抛错
		assert.throws(() => manager.update("ghost", { name: "ghost", description: "x", content: "" }), /does not exist/);

		// remove
		manager.remove("alpha-skill");
		assert.equal(existsSync(join(home, "skills")), true);
		assert.deepEqual(manager.list(), []);

		// remove 不存在静默
		manager.remove("ghost");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshSkillManager: flat .md files in the skills dir are listed too", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-skill-test-"));
	try {
		const manager = new DshSkillManager(() => home);
		manager.create({ name: "dir-skill", description: "目录形态", content: "x" });
		// 手工放一个扁平 .md（host 也识别这种形态）
		mkdirSync(join(home, "skills"), { recursive: true });
		writeFileSync(join(home, "skills", "flat-skill.md"), "---\nname: flat-skill\ndescription: 扁平形态\n---\n\nbody\n", "utf8");

		const names = manager.list().map((skill) => skill.name).sort();
		assert.deepEqual(names, ["dir-skill", "flat-skill"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
