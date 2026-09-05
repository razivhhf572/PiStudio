import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 纯函数模块（无 electron 依赖），直接编译执行，测行为不测实现
function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const { extractFocusTargetFromArgv } = compile("src/main/utils/focusTarget.ts");

const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AGENT_ID = "9c858b90-9e1e-4e8b-9f4e-8f9e9e9e9e9e";

// vm 上下文的对象原型与测试 realm 不同，deepStrictEqual 会误报，统一逐字段断言
function expectTarget(argv, expected) {
  const target = extractFocusTargetFromArgv(argv);
  assert.equal(target?.sessionId, expected.sessionId);
  assert.equal(target?.agentId, expected.agentId);
}

test("解析 pistudio://session/ 协议 URL（通知点击主路径）", () => {
  const argv = ["C:\\\\Program Files\\\\PiStudio\\\\PiStudio.exe", `pistudio://session/${SESSION_ID}`];
  expectTarget(argv, { sessionId: SESSION_ID, agentId: undefined });
});

test("解析 pistudio://agent/ 兼容格式（旧 toast 兜底）", () => {
  const argv = ["PiStudio.exe", `pistudio://agent/${AGENT_ID}`];
  expectTarget(argv, { sessionId: undefined, agentId: AGENT_ID });
});

test("协议 URL 大小写不敏感", () => {
  const upper = SESSION_ID.toUpperCase();
  const argv = ["PiStudio.exe", `PISTUDIO://SESSION/${upper}`];
  expectTarget(argv, { sessionId: upper, agentId: undefined });
});

test("无通知唤起参数时返回 undefined（仅聚焦窗口）", () => {
  assert.equal(extractFocusTargetFromArgv(["PiStudio.exe"]), undefined);
  assert.equal(extractFocusTargetFromArgv([]), undefined);
  assert.equal(extractFocusTargetFromArgv(undefined), undefined);
});

test("非 agent/session 协议（如 pistudio:// 根地址）不产生跳转目标", () => {
  assert.equal(extractFocusTargetFromArgv(["PiStudio.exe", "pistudio://"]), undefined);
});
