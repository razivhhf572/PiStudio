import { test, expect } from "./mock-pi-fixture";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * FileDiffViewer 右上角「双栏对比/单栏查看」切换按钮回归守护：
 * 复用 git-panel.spec.ts 的仓库初始化 + Git 面板 diff 打开路径（同一 FileDiffViewer 组件，
 * 工具卡/文件条打开的 diff 也走这个组件）。点击后必须切换 state（aria-pressed/title）
 * 并强制重建 CodeDiffView（key 变化 → 新 diffStyle 渲染）。
 */
const repoDir = join(tmpdir(), "pideck-seed-git-repo-toggle");

function git(args: string) {
	return execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8" }).trim();
}

rmSync(repoDir, { recursive: true, force: true });
mkdirSync(repoDir, { recursive: true });
git("init -b main");
git("config user.email e2e@pideck.local");
git("config user.name pideck-e2e");
writeFileSync(join(repoDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\n");
git("add .");
git("commit -m init");

test.use({
	seedProjects: [{ id: "e2e-git-repo-toggle", name: "GitE2EToggle", path: repoDir }],
});

test("diff viewer: split/unified toggle switches state and rebuilds view", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "GitE2EToggle" }).first();
	await projectRow.click();
	await projectRow.getByTitle("普通会话").first().click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });

	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true", { timeout: 5000 });
	await window.locator('[data-testid="drawer-rail-git"]').click();
	const panel = window.locator(".git-panel.bg-background");
	await expect(panel).toBeVisible({ timeout: 15_000 });

	// 替换中间一行 → 同时产生 deletion + addition
	const aPath = join(repoDir, "a.txt");
	const current = readFileSync(aPath, "utf8");
	writeFileSync(aPath, current.replace("line3", "line3-changed"));
	await panel.getByRole("button", { name: "刷新" }).first().click();
	const changedFile = panel.locator(".git-resource-name", { hasText: "a.txt" }).first();
	await expect(changedFile).toBeVisible({ timeout: 15_000 });

	await panel.locator(".git-resource-open", { hasText: "a.txt" }).first().click();
	await expect(window.locator(".file-diff-header")).toBeVisible({ timeout: 10_000 });
	// 等 diff 渲染完成（worker 计算 + 虚拟化）
	await expect(window.locator("[data-line-type]").first()).toBeVisible({ timeout: 15_000 });

	const actions = window.locator(".file-diff-header-actions");
	// 初始为分栏模式（sideBySide=true）：aria-pressed=true，title=单栏查看（目标状态）
	const toggle = actions.getByTitle("单栏查看");
	await expect(toggle).toBeVisible({ timeout: 5_000 });
	await expect(toggle).toHaveAttribute("aria-pressed", "true");

	// 等 split 布局渲染稳定后截图（作为切换前基准）
	await expect(window.locator('[data-line-type="change-deletion"]').first()).toBeVisible({ timeout: 10_000 });
	await window.waitForTimeout(800);
	const beforeShot = await window.locator(".code-diff-view").screenshot();

	await toggle.click();
	// state 切换：aria-pressed=false，title 变为目标状态「双栏对比」
	const toggled = actions.getByTitle("双栏对比");
	await expect(toggled).toBeVisible({ timeout: 5_000 });
	await expect(toggled).toHaveAttribute("aria-pressed", "false");
	// CodeDiffView key 变化强制重建（新 diffStyle），等重建稳定后对比像素
	await window.waitForTimeout(1500);
	const afterShot = await window.locator(".code-diff-view").screenshot();

	// 布局必须真的变化（split 两列 ↔ unified 单列），否则截图相同
	expect(afterShot.equals(beforeShot)).toBe(false);
});
