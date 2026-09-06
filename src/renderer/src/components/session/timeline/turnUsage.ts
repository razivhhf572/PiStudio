/**
 * 轮级 token 用量提取（纯函数，无 React 依赖，可单测）。
 *
 * 数据来源：assistant 消息的 meta.usage —— DSH 投影器（dshEventProjector.ts）在
 * assistant/message 落地时写入 inputTokens/outputTokens/tps；pi 侧由
 * AgentManager.settleMessagePerf 在 message_end 结算时写入。历史会话同样可读
 * （usage 随消息持久化），回看旧对话也能显示统计。
 *
 * 取「最后一条带 usage 的 assistant 消息」：一轮内可能有多个 assistant 消息
 * （中间回复 + 最终回复），终态消息的 usage 是完整回合的权威值；终态缺 usage
 * （异常路径）时回退前一条带 usage 的。全部缺失返回 undefined（UI 不渲染）。
 */
import type { AgentRunItem } from "../../app/AppUtils";

/** 一轮的 token 用量统计（全字段可选：缺失 = 无数据，UI 按有则显示）。 */
export type TurnUsageStats = {
	inputTokens?: number;
	outputTokens?: number;
	/** 生成速率（tokens/s）；缺失 = 未结算或历史数据无速率。 */
	tps?: number;
};

/** meta.usage 的运行时收窄：对象且含至少一个有效数字字段才返回。 */
export function buildTurnUsageStats(run: Pick<AgentRunItem, "items">): TurnUsageStats | undefined {
	let result: TurnUsageStats | undefined;
	for (const item of run.items) {
		if (item.kind !== "message" || item.message.role !== "assistant") continue;
		const usage = item.message.meta?.usage;
		if (!usage || typeof usage !== "object") continue;
		const u = usage as Record<string, unknown>;
		const inputTokens = typeof u.inputTokens === "number" ? u.inputTokens : undefined;
		const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : undefined;
		// 全零/缺失视为无效数据（骨架消息的占位 usage），跳过继续找更早的消息。
		if ((inputTokens ?? 0) <= 0 && (outputTokens ?? 0) <= 0) continue;
		result = {
			...(inputTokens != null && inputTokens > 0 ? { inputTokens } : {}),
			...(outputTokens != null && outputTokens > 0 ? { outputTokens } : {}),
			...(typeof u.tps === "number" && u.tps > 0 ? { tps: u.tps } : {}),
		};
	}
	return result;
}
