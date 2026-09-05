/**
 * 从进程 argv 中提取「点击系统通知」携带的会话/Agent 跳转目标。
 *
 * Windows toast 使用 activationType="protocol"，点击时系统按注册表协议关联唤起应用，
 * 被唤起实例的 argv 携带 launch URL。支持两种格式：
 * - pistudio://session/<uuid>：主路径。通知创建时直接嵌入会话 id（SessionRecord.id 跨重启稳定），
 *   冷启动/运行中均可跳转，不依赖 agent 运行时状态。
 * - pistudio://agent/<uuid>：兼容旧版 toast 的兜底格式（agent 运行时才可解析到会话）。
 * 返回 undefined 表示本次唤起不是通知点击，仅聚焦窗口即可。
 */
const FOCUS_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_RE = new RegExp(`pistudio://session/(${FOCUS_UUID})`, "i");
const AGENT_RE = new RegExp(`pistudio://agent/(${FOCUS_UUID})`, "i");

export type FocusTarget = {
	sessionId?: string;
	agentId?: string;
};

export function extractFocusTargetFromArgv(argv?: string[]): FocusTarget | undefined {
	if (!argv || argv.length === 0) return undefined;
	for (const arg of argv) {
		const text = String(arg);
		const sessionMatch = text.match(SESSION_RE);
		if (sessionMatch) return { sessionId: sessionMatch[1] };
		const agentMatch = text.match(AGENT_RE);
		if (agentMatch) return { agentId: agentMatch[1] };
	}
	return undefined;
}
