// scheduled只执行一个持久工作片；账号内阶段依赖与失败轮转由真实D1集成测试保护。
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

type ScheduledTask = () => Promise<unknown>;

const phaseMocks = vi.hoisted(() => ({
  runCronTick: vi.fn<ScheduledTask>(),
  consumeBuiltInIconIndexRefreshQueue: vi.fn(),
}));

vi.mock("./cron", () => ({ runCronTick: phaseMocks.runCronTick }));

vi.mock("./notifications", () => ({
  notificationHistory: vi.fn(),
  notificationRun: vi.fn(),
  notificationTest: vi.fn(),
}));

vi.mock("./cloud-backup", () => ({
  createCloudBackup: vi.fn(),
  deleteCloudBackup: vi.fn(),
  downloadCloudBackup: vi.fn(),
  listCloudBackups: vi.fn(),
  readCloudBackupConfig: vi.fn(),
  testCloudBackupConfig: vi.fn(),
  updateCloudBackupConfig: vi.fn(),
}));

vi.mock("./media-icon-index-refresh-queue", () => ({
  consumeBuiltInIconIndexRefreshQueue: phaseMocks.consumeBuiltInIconIndexRefreshQueue,
}));

function envFixture(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
    ...overrides,
  };
}

function readyEnvFixture(overrides: Partial<Env> = {}): Env {
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn().mockResolvedValue(sql.includes("sqlite_master")
      ? { results: [{ name: "users" }, { name: "d1_migrations" }] }
      : { results: [{ name: "id" }, { name: "role" }, { name: "banned" }] }),
    first: vi.fn().mockResolvedValue({ name: "0046_exclusive_cloud_backup_staging" }),
  }));
  return envFixture({ DB: { prepare } as unknown as D1Database, ...overrides });
}

async function runScheduled(env: Env = envFixture()): Promise<void> {
  if (!worker.scheduled) throw new Error("Expected scheduled handler");
  await worker.scheduled({
    scheduledTime: Date.parse("2026-06-17T00:00:00.000Z"),
    cron: "* * * * *",
    noRetry: vi.fn(),
  }, env, {} as ExecutionContext);
}

async function fetchWorker(request: Request, env: Env = envFixture()): Promise<Response> {
  if (!worker.fetch) throw new Error("Expected fetch handler");
  // Wrangler handler 的 Request 类型带 cf 元数据；单元测试只需要普通 Request 覆盖路由分派。
  return await worker.fetch(request as Parameters<NonNullable<typeof worker.fetch>>[0], env, {} as ExecutionContext);
}

async function runQueue(batch: MessageBatch, env: Env = envFixture()): Promise<void> {
  if (!worker.queue) throw new Error("Expected queue handler");
  await worker.queue(batch, env, {} as ExecutionContext);
}

describe("Cloudflare worker scheduled entrypoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    phaseMocks.runCronTick.mockReset();
    phaseMocks.consumeBuiltInIconIndexRefreshQueue.mockReset();
    phaseMocks.runCronTick.mockResolvedValue(undefined);
  });

  it("awaits one durable work unit", async () => {
    await runScheduled();
    expect(phaseMocks.runCronTick).toHaveBeenCalledTimes(1);
  });

  it("does not start work during maintenance", async () => {
    await runScheduled(envFixture({ RENEWLET_MAINTENANCE_MODE: "true" }));
    expect(phaseMocks.runCronTick).not.toHaveBeenCalled();
  });
});

describe("Cloudflare worker maintenance entrypoints", () => {
  it("returns a non-cacheable 503 before API routing", async () => {
    const response = await fetchWorker(
      new Request("https://renewlet.example/api/app/ready"),
      envFixture({ RENEWLET_MAINTENANCE_MODE: "true" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "MAINTENANCE_MODE",
        message: "Renewlet is temporarily unavailable during a database upgrade.",
        requestId: expect.any(String),
      },
    });
  });

  it("retries a race-delivered Queue batch without consuming it", async () => {
    const retryAll = vi.fn();
    const batch = { messages: [], queue: "refresh", retryAll, ackAll: vi.fn() } as unknown as MessageBatch;

    await runQueue(batch, envFixture({ RENEWLET_MAINTENANCE_MODE: "true" }));

    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 900 });
    expect(phaseMocks.consumeBuiltInIconIndexRefreshQueue).not.toHaveBeenCalled();
  });
});

describe("Cloudflare worker readiness", () => {
  it("requires the users schema and applied migrations", async () => {
    const response = await fetchWorker(
      new Request("https://renewlet.example/api/app/ready"),
      readyEnvFixture(),
    );

    expect(response.status).toBe(200);
  });

  it("returns APP_NOT_READY when the required schema is incomplete", async () => {
    const response = await fetchWorker(
      new Request("https://renewlet.example/api/app/ready"),
      readyEnvFixture({
        DB: {
          prepare: vi.fn((sql: string) => ({
            all: vi.fn().mockResolvedValue(sql.includes("sqlite_master")
              ? { results: [{ name: "users" }] }
              : { results: [] }),
            first: vi.fn().mockResolvedValue(null),
          })),
        } as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "APP_NOT_READY",
        requestId: expect.any(String),
      },
    });
  });
});

describe("Cloudflare app CSRF origin middleware", () => {
  it("rejects unsafe /api/app requests without Origin or Referer", async () => {
    const response = await fetchWorker(new Request("https://renewlet.example/api/app/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CSRF_ORIGIN_REQUIRED" },
    });
  });

  it("rejects unsafe /api/app requests from a different origin before handlers run", async () => {
    const response = await fetchWorker(new Request("https://renewlet.example/api/app/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CSRF_ORIGIN_MISMATCH" },
    });
  });
});
