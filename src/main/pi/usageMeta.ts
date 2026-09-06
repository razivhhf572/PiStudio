/**
 * pi 消息 meta.usage 挂载（纯函数，无副作用，可单测）。
 *
 * pi 侧 token 用量来自 message_end 的 usage 字段 + 本地性能结算（tps），
 * 由 AgentManager.settleMessagePerf 在消息落盘后调用本模块合并进消息：
 * 消息随会话文件持久化，历史会话回看也能显示每轮 token 用量与生成速率。
 * 与 DSH 侧（dshEventProjector 写入 meta.usage）同构，渲染层统一从
 * message.meta.usage 读取（见 turnUsage.ts）。
 */
import type { ChatMessage } from "../../shared/types";

/**
 * 把 usage 合并进消息数组「最后一条 assistant 消息」的 meta.usage（原地修改）。
 * 一轮内可能有多个 assistant 消息（中间回复 + 最终回复），终态消息才是完整回合
 * 的权威归属；已存在的 usage 字段保留（缓存等增量写入场景）。
 * @returns 被修改的消息下标；-1 = 数组为空或没有 assistant 消息。
 */
export function mergeUsageIntoLastAssistantMessage(
	messages: ChatMessage[],
	usage: Record<string, number>,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = messages[index];
		if (candidate.role !== "assistant") continue;
		candidate.meta = {
			...(candidate.meta ?? {}),
			usage: { ...((candidate.meta?.usage as Record<string, unknown> | undefined) ?? {}), ...usage },
		};
		return index;
	}
	return -1;
}
