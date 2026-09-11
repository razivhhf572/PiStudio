import type { ReactNode } from "react";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";

/**
 * 抽屉活动栏动作项：由 App 层组装。
 * rail 本体只负责渲染与激活态展示，不感知具体面板业务。
 *
 * - 默认是抽屉面板 tab（files/git/browser…），互斥切换右侧内容。
 * - `toggle` 是独立开关（如底部终端）：不切抽屉面板，也不与 tab 互斥。
 */
export type WorkspaceDrawerRailAction = {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  toggle?: boolean;
};

function DrawerRailButton(props: {
  action: WorkspaceDrawerRailAction;
  role: "tab" | "button";
}) {
  const { action, role } = props;
  return (
    <Button
      type="button"
      role={role}
      aria-selected={role === "tab" ? action.active : undefined}
      aria-pressed={role === "button" ? action.active : undefined}
      data-testid={`drawer-rail-${action.id}`}
      variant={action.active ? "secondary" : "ghost"}
      size="icon"
      className={cn(
        "drawer-activity-rail-button relative size-8",
        action.active && "active",
      )}
      title={action.label}
      aria-label={action.label}
      onClick={action.onClick}
    >
      {action.icon}
      {action.active ? (
        <span
          className="pointer-events-none absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-foreground"
          aria-hidden="true"
        />
      ) : null}
    </Button>
  );
}

/**
 * 右侧抽屉活动栏（#115 pure official）：横排 tab，shadcn ghost/secondary 按钮。
 * 抽屉打开期间始终可见，无活跃会话时也能切换 files/git/browser。
 * 开/关抽屉按钮留在会话 Tab 栏右侧，不进本栏。
 */
export function WorkspaceDrawerRail(props: { actions: WorkspaceDrawerRailAction[] }) {
  if (props.actions.length === 0) return null;
  const tabs = props.actions.filter((action) => !action.toggle);
  const toggles = props.actions.filter((action) => action.toggle);
  return (
    <div className="drawer-activity-rail flex h-10 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2">
      {tabs.length > 0 ? (
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-orientation="horizontal"
        >
          {tabs.map((action) => (
            <DrawerRailButton key={action.id} action={action} role="tab" />
          ))}
        </div>
      ) : null}
      {toggles.map((action) => (
        <DrawerRailButton key={action.id} action={action} role="button" />
      ))}
    </div>
  );
}
