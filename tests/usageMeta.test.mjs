/**
 * mergeUsageIntoLastAssistantMessage 单测：把 token 用量合并进最后一条
 * assistant 消息的 meta.usage（pi 侧持久化链路，与 DSH 投影器同构）。
 * 守护「倒序命中最后一条 assistant」「合并保留既有 usage/meta」「无 assistant 返回 -1」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeUsageIntoLastAssistantMessage } = loadTsCommonJs("src/main/pi/usageMeta.ts");

/** VM 沙箱返回的对象跨 realm，strict deepEqual 会比较原型；JSON 归一后比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function message(id, role, extra = {}) {
  return { id, agentId: "a", role, text: "hi", timestamp: 1, ...extra };
}

test("合并进最后一条 assistant 消息并返回其下标", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant"),
    message("t1", "tool"),
    message("a2", "assistant"),
  ];
  const index = mergeUsageIntoLastAssistantMessage(messages, { inputTokens: 1200, outputTokens: 340, tps: 32 });
  assert.equal(index, 3);
  assert.deepEqual(plain(messages[3].meta?.usage), { inputTokens: 1200, outputTokens: 340, tps: 32 });
  assert.equal(messages[1].meta, undefined, "非最后一条 assistant 不动");
});

test("保留既有 meta 与已有 usage 字段（增量合并）", () => {
  const messages = [
    message("a1", "assistant", {
      meta: { other: 1, usage: { inputTokens: 500, cacheReadTokens: 300 } },
    }),
  ];
  mergeUsageIntoLastAssistantMessage(messages, { outputTokens: 200, tps: 25 });
  assert.deepEqual(plain(messages[0].meta), {
    other: 1,
    usage: { inputTokens: 500, cacheReadTokens: 300, outputTokens: 200, tps: 25 },
  });
});

test("无 assistant 消息返回 -1 且不改数组", () => {
  const messages = [message("u1", "user"), message("t1", "tool")];
  const index = mergeUsageIntoLastAssistantMessage(messages, { outputTokens: 10 });
  assert.equal(index, -1);
  assert.equal(messages[0].meta, undefined);
  assert.equal(messages[1].meta, undefined);
});

test("空数组返回 -1", () => {
  assert.equal(mergeUsageIntoLastAssistantMessage([], { outputTokens: 10 }), -1);
});
