import { Component, lazy, Suspense, useMemo, useState } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { SETTINGS_ADVANCED_GROUPS, type SettingsAdvancedGroup } from "./settings-advanced-groups";
import { SettingsAdvancedGroupPlaceholder } from "./settings-advanced-group-placeholder";
import type { SettingsSectionId } from "./settings-section-navigation";

type SettingsAdvancedGroupComponentProps = {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
};

const groupLoaders: Record<SettingsAdvancedGroup, () => Promise<{ default: ComponentType<SettingsAdvancedGroupComponentProps> }>> = {
  resourcesAi: () => import("./settings-advanced-group-resources-ai").then((module) => ({ default: module.SettingsAdvancedResourcesAiGroup })),
  budgetData: () => import("./settings-advanced-group-budget-data").then((module) => ({ default: module.SettingsAdvancedBudgetDataGroup })),
  cloudCalendar: () => import("./settings-advanced-group-cloud-calendar").then((module) => ({ default: module.SettingsAdvancedCloudCalendarGroup })),
  publicNotifications: () => import("./settings-advanced-group-public-notifications").then((module) => ({ default: module.SettingsAdvancedPublicNotificationsGroup })),
};

function createLazyGroup(group: SettingsAdvancedGroup): LazyExoticComponent<ComponentType<SettingsAdvancedGroupComponentProps>> {
  return lazy(groupLoaders[group]);
}

const lazyGroups: Record<SettingsAdvancedGroup, LazyExoticComponent<ComponentType<SettingsAdvancedGroupComponentProps>>> = {
  resourcesAi: createLazyGroup("resourcesAi"),
  budgetData: createLazyGroup("budgetData"),
  cloudCalendar: createLazyGroup("cloudCalendar"),
  publicNotifications: createLazyGroup("publicNotifications"),
};

function resetLazyGroup(group: SettingsAdvancedGroup) {
  lazyGroups[group] = createLazyGroup(group);
}

export function preloadSettingsAdvancedGroup(group: SettingsAdvancedGroup): void {
  void groupLoaders[group]().catch(() => undefined);
}

function SettingsAdvancedGroupBoundary({
  group,
  controller,
  onReady,
  onRetry,
  retryVersion,
}: SettingsAdvancedGroupComponentProps & {
  group: SettingsAdvancedGroup;
  onRetry: () => void;
  retryVersion: number;
}) {
  const LazyGroup = lazyGroups[group];
  return (
    <Suspense fallback={<SettingsAdvancedGroupPlaceholder group={group} />}>
      <LazyGroup controller={controller} onReady={onReady} />
    </Suspense>
  );
}

class SettingsAdvancedGroupErrorBoundary extends Component<
  SettingsAdvancedGroupComponentProps & { group: SettingsAdvancedGroup; onRetry: () => void; retryVersion: number },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <SettingsAdvancedGroupPlaceholder group={this.props.group} error onRetry={this.props.onRetry} />;
    }
    return <SettingsAdvancedGroupBoundary {...this.props} />;
  }
}

export function SettingsAdvancedSections({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: ((sectionIds: readonly SettingsSectionId[]) => void) | undefined;
}) {
  const [retryVersions, setRetryVersions] = useState<Record<SettingsAdvancedGroup, number>>({
    resourcesAi: 0,
    budgetData: 0,
    cloudCalendar: 0,
    publicNotifications: 0,
  });

  const groups = useMemo(() => Object.keys(groupLoaders) as SettingsAdvancedGroup[], []);
  return (
    <>
      {groups.map((group) => {
        const retry = () => {
          resetLazyGroup(group);
          setRetryVersions((current) => ({ ...current, [group]: current[group] + 1 }));
        };
        return (
          <div key={`${group}-${retryVersions[group]}`} className="contents">
            <SettingsAdvancedGroupErrorBoundary
              group={group}
              controller={controller}
              // 代码提交只代表本组 DOM 已进入布局；导航必须知道本次提交覆盖哪些 section，避免并行分组误结束目标校正。
              onReady={() => onReady?.(SETTINGS_ADVANCED_GROUPS[group])}
              onRetry={retry}
              retryVersion={retryVersions[group]}
            />
          </div>
        );
      })}
    </>
  );
}
