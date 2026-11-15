import { createRef, forwardRef, useImperativeHandle } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsSectionList,
  useSettingsSectionNavigation,
} from "./settings-section-navigation";

const TEST_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-display",
  "settings-cloud-backup",
  "settings-calendar-feed",
  "settings-notifications",
];
const DEFERRED_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-cloud-backup",
  "settings-calendar-feed",
  "settings-notifications",
];
const RESOURCES_AI_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-icon-sources",
  "settings-uploaded-icons",
  "settings-ai-recognition",
];
const CLOUD_CALENDAR_SECTION_IDS: readonly SettingsSectionId[] = [
  "settings-cloud-backup",
  "settings-calendar-feed",
];
const TEST_SECTIONS: SettingsSectionList = SETTINGS_SECTIONS.filter((section) =>
  TEST_SECTION_IDS.some((id) => id === section.id)
);

type NavigationHarnessHandle = {
  markDeferredSectionsReady: (sectionIds: readonly SettingsSectionId[]) => void;
};

const NavigationHarness = forwardRef<NavigationHarnessHandle>(function NavigationHarness(_, ref) {
  const {
    activeSectionId,
    handleSectionClick,
    markDeferredSectionsReady,
  } = useSettingsSectionNavigation(TEST_SECTIONS, {
    deferredSectionIds: DEFERRED_SECTION_IDS,
  });
  useImperativeHandle(ref, () => ({ markDeferredSectionsReady }), [markDeferredSectionsReady]);
  const location = useLocation();

  return (
    <div id="root">
      <output data-testid="route-hash">{location.hash}</output>
      <nav aria-label="设置目录测试">
        {TEST_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={activeSectionId === section.id ? "location" : undefined}
            onClick={(event) => {
              event.preventDefault();
              handleSectionClick(section.id);
            }}
          >
            {section.id}
          </a>
        ))}
      </nav>
      {TEST_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} aria-busy={DEFERRED_SECTION_IDS.includes(section.id) ? "true" : undefined}>{section.id}</section>
      ))}
    </div>
  );
});

function setElementRect(element: Element, top: number, height = 160) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left: 0,
      right: 960,
      top,
      width: 960,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } satisfies DOMRect),
  });
}

function renderNavigation(initialEntry = "/settings") {
  const readyRef = createRef<NavigationHarnessHandle>();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NavigationHarness ref={readyRef} />
    </MemoryRouter>,
  );
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement)) throw new Error("Missing settings scroll root");
  setElementRect(root, 0, 800);
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 800 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 3000 });
  Object.defineProperty(root, "scrollTop", { configurable: true, value: 0, writable: true });

  const scrollSpies = new Map<SettingsSectionId, ReturnType<typeof vi.fn>>();
  for (const id of TEST_SECTION_IDS) {
    const section = document.getElementById(id);
    if (!(section instanceof HTMLElement)) throw new Error(`Missing test section: ${id}`);
    const scrollIntoView = vi.fn();
    Object.defineProperty(section, "scrollIntoView", { configurable: true, value: scrollIntoView });
    section.style.scrollMarginTop = "100px";
    scrollSpies.set(id, scrollIntoView);
  }

  return {
    root,
    scrollSpy(id: SettingsSectionId) {
      const spy = scrollSpies.get(id);
      if (!spy) throw new Error(`Missing scroll spy: ${id}`);
      return spy;
    },
    markReady(sectionIds: readonly SettingsSectionId[]) {
      act(() => readyRef.current?.markDeferredSectionsReady(sectionIds));
    },
  };
}

function setCloudBackupAtAnchor() {
  setElementRect(document.getElementById("settings-display")!, -300);
  setElementRect(document.getElementById("settings-cloud-backup")!, 40);
  setElementRect(document.getElementById("settings-calendar-feed")!, 300);
  setElementRect(document.getElementById("settings-notifications")!, 600);
}

describe("deferred settings section navigation", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      window.clearTimeout(handle);
    });
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("scrolls to the deferred skeleton immediately and corrects after commit", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();

    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));

    expect(screen.getByTestId("route-hash")).toHaveTextContent("#settings-calendar-feed");
    expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();

    navigation.scrollSpy("settings-calendar-feed").mockClear();
    navigation.markReady(RESOURCES_AI_SECTION_IDS);
    expect(navigation.scrollSpy("settings-calendar-feed")).not.toHaveBeenCalled();
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
  });

  it("realigns a committed section even when it still covers the active anchor", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    const calendarSection = document.getElementById("settings-calendar-feed")!;
    setElementRect(calendarSection, 100, 1000);
    setElementRect(document.getElementById("settings-display")!, -1100);
    setElementRect(document.getElementById("settings-cloud-backup")!, -950);
    setElementRect(document.getElementById("settings-notifications")!, 800);

    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.scrollSpy("settings-calendar-feed").mockClear();
    setElementRect(calendarSection, -681, 1000);
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
    expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
  });

  it("starts the correction window when a delayed deferred group commits", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);

    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.scrollSpy("settings-calendar-feed").mockClear();
    setCloudBackupAtAnchor();
    now.mockReturnValue(2_001);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
  });

  it("corrects a later layout shift after the committed section initially settles", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    const calendarSection = document.getElementById("settings-calendar-feed")!;
    setElementRect(calendarSection, 100);
    setElementRect(document.getElementById("settings-notifications")!, 1200);

    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);
    act(() => navigation.root.dispatchEvent(new Event("scrollend")));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    navigation.scrollSpy("settings-calendar-feed").mockClear();
    setElementRect(calendarSection, 881);
    act(() => navigation.root.dispatchEvent(new Event("scrollend")));

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
  });

  it("ignores layout scroll and scrollend while waiting for deferred content", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.scrollSpy("settings-calendar-feed").mockClear();
    setCloudBackupAtAnchor();

    act(() => {
      navigation.root.dispatchEvent(new Event("scroll"));
      navigation.root.dispatchEvent(new Event("scrollend"));
    });

    expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("link", { name: "settings-cloud-backup" })).not.toHaveAttribute("aria-current");
  });

  it("does not resume deferred navigation after user scroll input cancels it", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.scrollSpy("settings-calendar-feed").mockClear();
    setCloudBackupAtAnchor();

    act(() => {
      navigation.root.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    expect(screen.getByRole("link", { name: "settings-cloud-backup" })).toHaveAttribute("aria-current", "location");
    expect(navigation.scrollSpy("settings-calendar-feed")).not.toHaveBeenCalled();
  });

  it("scrolls only to the latest deferred section selected before commit", async () => {
    const user = userEvent.setup();
    const navigation = renderNavigation();

    await user.click(screen.getByRole("link", { name: "settings-cloud-backup" }));
    navigation.scrollSpy("settings-cloud-backup").mockClear();
    await user.click(screen.getByRole("link", { name: "settings-calendar-feed" }));
    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    expect(navigation.scrollSpy("settings-cloud-backup")).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
    expect(screen.getByTestId("route-hash")).toHaveTextContent("#settings-calendar-feed");
  });

  it("resolves an initial deferred section hash against the skeleton before commit", async () => {
    const navigation = renderNavigation("/settings#settings-calendar-feed");

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "settings-calendar-feed" })).toHaveAttribute("aria-current", "location");
    });
    expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();

    navigation.markReady(CLOUD_CALENDAR_SECTION_IDS);

    await waitFor(() => {
      expect(navigation.scrollSpy("settings-calendar-feed")).toHaveBeenCalled();
    });
  });
});
