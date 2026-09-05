import { test, expect } from "./mock-pi-fixture";

/**
 * 复现：composer 底栏模型/思考档位修改后 UI 不更新（停留默认值）。
 * 场景 A（引导页/欢迎页，无 record）：选模型后底栏应立刻反映；弹窗重开 check 应在新模型上。
 * 场景 B（思考档位）：选档位后应有反馈（当前实现直接关闭弹窗、UI 无变化）。
 */
test("引导页：选择模型后底栏与弹窗 check 应更新", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 引导页 composer 可用（不输入，不激活 agent）
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 底栏模型/思考合并 chip（Popover drill-in）
	const chip = window.locator(".composer-bar-btn.model-thinking");
	await expect(chip).toBeVisible();
	const beforeText = (await chip.textContent()) ?? "";
	console.log("[repro] before:", beforeText);

	// 打开 chip 小菜单 → 点「模型」进入选择器
	await chip.click();
	// Popover 菜单内两个 drill-in 行：模型（第一行）、思考（第二行）
	const chipMenu = window.locator("[data-radix-popper-content-wrapper]");
	const modelRow = chipMenu.locator("button").filter({ hasText: "模型" }).first();
	await expect(modelRow).toBeVisible({ timeout: 5_000 });
	await modelRow.click();

	// 模型选择器：选 mock-model-pro
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible();
	await expect(
		picker.locator('[data-picker-value="mock/mock-model-pro"]'),
	).toBeVisible({ timeout: 30_000 });
	await picker.locator('[data-picker-value="mock/mock-model-pro"]').click();
	await expect(picker).toHaveCount(0, { timeout: 5_000 });

	// 底栏应立即显示新模型（当前 bug：停留在默认 / "-"）
	await expect(chip).toContainText("mock-model-pro", { timeout: 5_000 });

	// 重开弹窗：check 应落在新模型行（当前 bug：仍在默认模型行）
	await chip.click();
	const chipMenu2 = window.locator("[data-radix-popper-content-wrapper]");
	const modelRow2 = chipMenu2.locator("button").filter({ hasText: "模型" }).first();
	await expect(modelRow2).toBeVisible({ timeout: 5_000 });
	await modelRow2.click();
	await expect(picker).toBeVisible();
	const selectedRow = picker.locator(
		'[data-picker-value="mock/mock-model-pro"] .lucide-check',
	);
	await expect(selectedRow).toBeVisible({ timeout: 10_000 });
	const oldSelectedRow = picker.locator(
		'[data-picker-value="mock/mock-model"] .lucide-check',
	);
	await expect(oldSelectedRow).toHaveCount(0);
	// 关闭弹窗（Esc）
	await window.keyboard.press("Escape");
	await expect(picker).toHaveCount(0, { timeout: 5_000 });

	// 思考档位：选 high 应即时反映到底栏（修复前：无 record 分支静默丢弃）
	await chip.click();
	const chipMenu3 = window.locator("[data-radix-popper-content-wrapper]");
	const thinkingRow = chipMenu3.locator("button").filter({ hasText: "思考" }).first();
	await expect(thinkingRow).toBeVisible({ timeout: 5_000 });
	await thinkingRow.click();
	const thinking = window.locator(".thinking-picker");
	await expect(thinking).toBeVisible();
	await thinking.locator('[data-picker-value="high"]').click();
	await expect(thinking).toHaveCount(0, { timeout: 5_000 });
	await expect(chip).toContainText("high", { timeout: 5_000 });
});

/**
 * 引导页选择 → 首次发送创建会话：所选模型/思考档位必须真实套用到新会话 record
 * （用户主动指名优先于一切默认解析，含显式默认模型）。
 */
test("引导页：选择模型/档位后发送，新会话应套用所选值", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	const chip = window.locator(".composer-bar-btn.model-thinking");
	await expect(chip).toBeVisible();

	// 选模型 mock-model-pro
	await chip.click();
	const chipMenu = window.locator("[data-radix-popper-content-wrapper]");
	const modelRow = chipMenu.locator("button").filter({ hasText: "模型" }).first();
	await expect(modelRow).toBeVisible({ timeout: 5_000 });
	await modelRow.click();
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible();
	await expect(
		picker.locator('[data-picker-value="mock/mock-model-pro"]'),
	).toBeVisible({ timeout: 30_000 });
	await picker.locator('[data-picker-value="mock/mock-model-pro"]').click();
	await expect(picker).toHaveCount(0, { timeout: 5_000 });
	await expect(chip).toContainText("mock-model-pro", { timeout: 5_000 });

	// 选思考档位 high
	await chip.click();
	const chipMenu2 = window.locator("[data-radix-popper-content-wrapper]");
	const thinkingRow = chipMenu2.locator("button").filter({ hasText: "思考" }).first();
	await expect(thinkingRow).toBeVisible({ timeout: 5_000 });
	await thinkingRow.click();
	const thinking = window.locator(".thinking-picker");
	await expect(thinking).toBeVisible();
	await thinking.locator('[data-picker-value="high"]').click();
	await expect(thinking).toHaveCount(0, { timeout: 5_000 });
	await expect(chip).toContainText("high", { timeout: 5_000 });

	// 发送：触发 ensureSessionForSend → createDraft（userDataRoot/.pi/agent 无显式默认）
	await composer.click();
	await window.keyboard.type("你好 mock");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", {
		timeout: 30_000,
	});

	// 新会话 record 必须带上所选模型与思考档位：
	// mock-pi 默认模型是 mock-model；若 createDraft 套用了所选值，
	// agent 激活后底栏会显示 Mock Model Pro + high（否则回落到 mock-model/medium）。
	await expect(chip).toContainText("Mock Model Pro", { timeout: 15_000 });
	await expect(chip).toContainText("high", { timeout: 5_000 });
});

/**
 * 真实会话（Agent 已激活、runtime live）：选模型后底栏与弹窗 check 应更新，
 * 思考档位选择应生效。当前 bug：全部停留在默认值。
 */
test("真实会话：切换模型/思考档位后底栏与弹窗 check 应更新", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 发送消息激活 agent（spawn mock pi）
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("你好 mock");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", {
		timeout: 30_000,
	});

	const chip = window.locator(".composer-bar-btn.model-thinking");
	await expect(chip).toBeVisible();
	// Agent 激活后底栏应显示 mock 默认模型（get_state 返回 model.name "Mock Model"）
	await expect(chip).toContainText("Mock Model", { timeout: 10_000 });
	console.log("[repro-live] before:", await chip.textContent());

	// 打开模型选择器，选 mock-model-pro
	await chip.click();
	const chipMenu = window.locator("[data-radix-popper-content-wrapper]");
	const modelRow = chipMenu.locator("button").filter({ hasText: "模型" }).first();
	await expect(modelRow).toBeVisible({ timeout: 5_000 });
	await modelRow.click();
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible();
	await expect(
		picker.locator('[data-picker-value="mock/mock-model-pro"]'),
	).toBeVisible({ timeout: 30_000 });
	await picker.locator('[data-picker-value="mock/mock-model-pro"]').click();
	await expect(picker).toHaveCount(0, { timeout: 5_000 });

	// 底栏应立即显示新模型（显示 model.name "Mock Model Pro"）
	await expect(chip).toContainText("Mock Model Pro", { timeout: 10_000 });

	// 重开弹窗：check 应落在新模型行
	await chip.click();
	const chipMenu2 = window.locator("[data-radix-popper-content-wrapper]");
	const modelRow2 = chipMenu2.locator("button").filter({ hasText: "模型" }).first();
	await expect(modelRow2).toBeVisible({ timeout: 5_000 });
	await modelRow2.click();
	await expect(picker).toBeVisible();
	await expect(
		picker.locator('[data-picker-value="mock/mock-model-pro"] .lucide-check'),
	).toBeVisible({ timeout: 10_000 });
	await expect(
		picker.locator('[data-picker-value="mock/mock-model"] .lucide-check'),
	).toHaveCount(0);
	await window.keyboard.press("Escape");
	await expect(picker).toHaveCount(0, { timeout: 5_000 });

	// 思考档位：选 high，底栏应反映（mock 支持任意档位）
	await chip.click();
	const chipMenu3 = window.locator("[data-radix-popper-content-wrapper]");
	const thinkingRow = chipMenu3.locator("button").filter({ hasText: "思考" }).first();
	await expect(thinkingRow).toBeVisible({ timeout: 5_000 });
	await thinkingRow.click();
	const thinking = window.locator(".thinking-picker");
	await expect(thinking).toBeVisible();
	await expect(thinking.locator('[data-picker-value="high"]')).toBeVisible({
		timeout: 10_000,
	});
	await thinking.locator('[data-picker-value="high"]').click();
	await expect(thinking).toHaveCount(0, { timeout: 5_000 });
	await expect(chip).toContainText("high", { timeout: 10_000 });
});
