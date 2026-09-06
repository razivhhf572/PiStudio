/**
 * buildTurnUsageStats 单测：从一轮 agent-run 提取 token 用量与生成速率。
 * 守护「取最后一条带 usage 的 assistant 消息」「全零/非法 usage 跳过」「无数据返回
 * undefined（UI 不渲染统计行）」三类规则；tps 来自 DSH 投影器 / pi 结算写入的
 * meta.usage（inputTokens/outputTokens/tps）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildTurnUsageStats } = loadTsCommonJs(
  "src/renderer/src/components/session/timeline/turnUsage.ts",
);

/** VM 沙箱返回的对象跨 realm，strict deepEqual 会比较原型；JSON 归一后比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 构造最小 agent-run（items 只放消息，忽略工具/思考组）。 */
function runWith(items) {
  return { kind: "agent-run", id: "run-1", startedAt: 1, endedAt: 2, items };
}

function assistantMessage(id, meta) {
  return { kind: "message", message: { id, agentId: "a", role: "assistant", text: "hi", timestamp: 1, ...(meta !== undefined ? { meta } : {}) } };
}

function userMessage(id) {
  return { kind: "message", message: { id, agentId: "a", role: "user", text: "yo", timestamp: 1 } };
}

test("无 assistant 消息返回 undefined", () => {
  assert.equal(buildTurnUsageStats(runWith([userMessage("u1")])), undefined);
  assert.equal(buildTurnUsageStats(runWith([])), undefined);
});

test("assistant 消息无 meta.usage 返回 undefined", () => {
  assert.equal(buildTurnUsageStats(runWith([assistantMessage("a1")])), undefined);
  assert.equal(buildTurnUsageStats(runWith([assistantMessage("a1", { other: 1 })])), undefined);
});

test("DSH 形状 usage 提取 input/output tokens", () => {
  const result = buildTurnUsageStats(
    runWith([
      assistantMessage("a1", { usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 500, cacheWriteTokens: 100 } }),
    ]),
  );
  assert.deepEqual(plain(result), { inputTokens: 1200, outputTokens: 340 });
});

test("usage 携带 tps 时一并提取", () => {
  const result = buildTurnUsageStats(
    runWith([assistantMessage("a1", { usage: { inputTokens: 900, outputTokens: 260, tps: 32.4 } })]),
  );
  assert.deepEqual(plain(result), { inputTokens: 900, outputTokens: 260, tps: 32.4 });
});

test("多条 assistant 消息取最后一条带 usage 的", () => {
  // 中间回复（工具回合）也带 usage，但终态消息才是完整回合的权威值。
  const result = buildTurnUsageStats(
    runWith([
      assistantMessage("a1", { usage: { inputTokens: 100, outputTokens: 50 } }),
      assistantMessage("a2", { usage: { inputTokens: 1200, outputTokens: 340, tps: 28 } }),
    ]),
  );
  assert.deepEqual(plain(result), { inputTokens: 1200, outputTokens: 340, tps: 28 });
});

test("最后一条 assistant 无 usage 时回退到前一条带 usage 的", () => {
  const result = buildTurnUsageStats(
    runWith([
      assistantMessage("a1", { usage: { inputTokens: 800, outputTokens: 200 } }),
      assistantMessage("a2"), // 终态骨架没写 usage（异常路径）
    ]),
  );
  assert.deepEqual(plain(result), { inputTokens: 800, outputTokens: 200 });
});

test("usage 全零（无效数据）跳过", () => {
  assert.equal(
    buildTurnUsageStats(runWith([assistantMessage("a1", { usage: { inputTokens: 0, outputTokens: 0 } })])),
    undefined,
  );
});

test("usage 非对象（历史脏数据）跳过", () => {
  assert.equal(buildTurnUsageStats(runWith([assistantMessage("a1", { usage: "oops" })])), undefined);
});

test("tps 非正数不提取", () => {
  const result = buildTurnUsageStats(
    runWith([assistantMessage("a1", { usage: { inputTokens: 900, outputTokens: 260, tps: 0 } })]),
  );
  assert.deepEqual(plain(result), { inputTokens: 900, outputTokens: 260 });
});

test("usage 缺失部分字段时只带有的字段", () => {
  const result = buildTurnUsageStats(
    runWith([assistantMessage("a1", { usage: { outputTokens: 340 } })]),
  );
  assert.deepEqual(plain(result), { outputTokens: 340 });
});
