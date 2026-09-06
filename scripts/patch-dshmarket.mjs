#!/usr/bin/env node
/**
 * dshmarket windowsHide 补丁（幂等）。
 *
 * 背景：dshmarket 的 spawnShim（lib/dsh-cli.js）spawn dsh CLI / pnpm 时未带
 * windowsHide，host 隐藏控制台分配失败（或 ESM 快照绕过 child_process 补丁）时
 * 会弹出可见 cmd 窗口。本脚本给 node_modules/dshmarket/lib/dsh-cli.js 的三处
 * spawn 调用注入 windowsHide: true。
 *
 * 幂等：已打补丁则跳过；npm install 重装 dshmarket 后补丁丢失，重跑即恢复。
 * 挂载：package.json postinstall（与 fix-pty-permissions 串联）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const target = join(projectRoot, "node_modules", "dshmarket", "lib", "dsh-cli.js");

const MARKER = "windowsHide: true";

if (!existsSync(target)) {
  console.log("[patch-dshmarket] dshmarket not installed, skip");
  process.exit(0);
}

let source = readFileSync(target, "utf8");
if (source.includes(MARKER)) {
  console.log("[patch-dshmarket] already patched, skip");
  process.exit(0);
}

// 三处 spawn 调用：非 shell 直启 ×2（win32 / 其他平台分支）+ cmd.exe shim 分支。
const before = source;
source = source
  .replaceAll(
    "return spawn(file, [...args], { ...spawnOptions, shell: false });",
    "return spawn(file, [...args], { ...spawnOptions, shell: false, windowsHide: true });",
  )
  .replaceAll(
    "return spawn(COMSPEC, ['/d', '/s', '/c', `\"${cmdCommandLine([file, ...args])}\"`], {\n        ...spawnOptions,\n        shell: false,\n        windowsVerbatimArguments: true,\n    });",
    "return spawn(COMSPEC, ['/d', '/s', '/c', `\"${cmdCommandLine([file, ...args])}\"`], {\n        ...spawnOptions,\n        shell: false,\n        windowsVerbatimArguments: true,\n        windowsHide: true,\n    });",
  );

if (source === before || !source.includes(MARKER)) {
  console.error("[patch-dshmarket] FAILED: pattern not found, dshmarket version may have changed");
  process.exit(1);
}

writeFileSync(target, source, "utf8");
console.log("[patch-dshmarket] patched windowsHide into dshmarket/lib/dsh-cli.js");
