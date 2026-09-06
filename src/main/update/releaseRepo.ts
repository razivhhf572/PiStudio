/**
 * PiStudio 更新所指向的 GitHub 仓库坐标（唯一事实来源）。
 * 本项目为 ayuayue/PiStudio 的 fork，发布仓库为 razivhhf572/PiStudio：
 * 旧坐标（ayuayue/PiDeck、ayuayue/PiStudio）目前虽能靠 GitHub 改名/重定向工作，
 * 但一旦失效（旧名被他人注册/回收、fork 与上游分叉）更新检查会直接 404，
 * 发布新版本前必须确认此处与 package.json build.publish 指向同一仓库。
 *
 * electron-updater 的 GitHub provider 从 package.json build.publish 读取仓库坐标
 * （生成 app-update.yml）；此常量用于运行时重建官方源 feed（setFeedUrl）与
 * 非更新链路的 Release 资产 URL（如 DSH runtime 索引、设置页跳转）。
 */
export const UPDATE_REPO_OWNER = "razivhhf572";
export const UPDATE_REPO = "PiStudio";

export const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
