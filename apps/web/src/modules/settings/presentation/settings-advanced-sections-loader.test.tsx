import { useLayoutEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { DeferredSettingsAdvancedSections } from "./settings-advanced-sections-loader";

type MockGroupProps = {
  onReady?: (() => void) | undefined;
};

vi.mock("./settings-advanced-group-placeholder", () => ({
  SettingsAdvancedGroupPlaceholder: ({ group }: { group: string }) => (
    <div data-testid={`advanced-placeholder-${group}`} aria-busy="true" />
  ),
}));

vi.mock("./settings-advanced-group-resources-ai", () => ({
  SettingsAdvancedResourcesAiGroup: ({ onReady }: MockGroupProps) => {
    useLayoutEffect(() => onReady?.(), [onReady]);
    return <section data-testid="advanced-group-resourcesAi" />;
  },
}));

vi.mock("./settings-advanced-group-budget-data", () => ({
  SettingsAdvancedBudgetDataGroup: ({ onReady }: MockGroupProps) => {
    useLayoutEffect(() => onReady?.(), [onReady]);
    return <section data-testid="advanced-group-budgetData" />;
  },
}));

vi.mock("./settings-advanced-group-cloud-calendar", () => ({
  SettingsAdvancedCloudCalendarGroup: ({ onReady }: MockGroupProps) => {
    useLayoutEffect(() => onReady?.(), [onReady]);
    return <section data-testid="advanced-group-cloudCalendar" />;
  },
}));

vi.mock("./settings-advanced-group-public-notifications", () => ({
  SettingsAdvancedPublicNotificationsGroup: ({ onReady }: MockGroupProps) => {
    useLayoutEffect(() => onReady?.(), [onReady]);
    return <section data-testid="advanced-group-publicNotifications" />;
  },
}));

describe("DeferredSettingsAdvancedSections", () => {
  it("mounts every group without waiting for a section scroll or hash", async () => {
    const onReady = vi.fn();

    render(
      <DeferredSettingsAdvancedSections
        controller={{} as SettingsFormController}
        onReady={onReady}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("advanced-group-resourcesAi")).toBeInTheDocument();
      expect(screen.getByTestId("advanced-group-budgetData")).toBeInTheDocument();
      expect(screen.getByTestId("advanced-group-cloudCalendar")).toBeInTheDocument();
      expect(screen.getByTestId("advanced-group-publicNotifications")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("advanced-placeholder-resourcesAi")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advanced-placeholder-budgetData")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advanced-placeholder-cloudCalendar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("advanced-placeholder-publicNotifications")).not.toBeInTheDocument();
    expect(onReady).toHaveBeenCalledTimes(4);
    expect(onReady).toHaveBeenCalledWith(["settings-icon-sources", "settings-uploaded-icons", "settings-ai-recognition"]);
    expect(onReady).toHaveBeenCalledWith(["settings-budget", "settings-data-config", "settings-exchange"]);
    expect(onReady).toHaveBeenCalledWith(["settings-cloud-backup", "settings-calendar-feed"]);
    expect(onReady).toHaveBeenCalledWith(["settings-public-status", "settings-public-api", "settings-timezone", "settings-notifications"]);
  });
});
