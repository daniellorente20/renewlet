// These tests pin what Renewlet is allowed to know about the people who use it: an internal id and a
// timestamp, never a name, an email or the identifier someone typed into a failed login.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { login, mfaVerify, requireAuth } from "./auth";
import { toResponse } from "./http";
import type { Env, SessionAuthRow, UserRow } from "./types";

const mocks = vi.hoisted(() => ({
  ensureSettings: vi.fn(),
  findUserByEmail: vi.fn(),
  nowIso: vi.fn(),
  sha256: vi.fn(),
  verifyPassword: vi.fn(),
  authenticatorMfaMethodsForUser: vi.fn(),
  createMfaAuthTicket: vi.fn(),
  verifyMfaLogin: vi.fn(),
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    ensureSettings: mocks.ensureSettings,
    findUserByEmail: mocks.findUserByEmail,
    nowIso: mocks.nowIso,
  };
});

vi.mock("./crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crypto")>();
  return { ...actual, sha256: mocks.sha256, verifyPassword: mocks.verifyPassword };
});

vi.mock("./mfa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mfa")>();
  return {
    ...actual,
    authenticatorMfaMethodsForUser: mocks.authenticatorMfaMethodsForUser,
    createMfaAuthTicket: mocks.createMfaAuthTicket,
    verifyMfaLogin: mocks.verifyMfaLogin,
  };
});

beforeEach(() => {
  mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
  mocks.findUserByEmail.mockReset();
  mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
  mocks.sha256.mockReset().mockResolvedValue("token-hash");
  mocks.verifyPassword.mockReset().mockResolvedValue(true);
  mocks.authenticatorMfaMethodsForUser.mockReset().mockResolvedValue([]);
  mocks.createMfaAuthTicket.mockReset().mockResolvedValue({
    ticketId: "mfa-ticket",
    expiresAt: "2026-06-03T00:05:00.000Z",
    methods: ["totp"],
  });
  mocks.verifyMfaLogin.mockReset().mockResolvedValue({
    response: {
      type: "session",
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      user: { id: "usr_mfa", email: "mfa@example.com", name: "MFA User", role: "user", banned: false },
    },
    sessionToken: "mfa-session",
    csrfToken: "csrf-token",
    expiresAt: "2026-07-03T00:00:00.000Z",
  });
});

describe("Cloudflare login logging", () => {
  it("logs a resolved login with the internal id and nothing that names the person", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_login", email: "login@example.com", name: "Renewlet Owner" }));

    const response = await login(loginRequest("login@example.com"), writeEnvFixture());

    expect(response.status).toBe(200);
    expect(consoleLog).toHaveBeenCalledWith({ event: "login", ok: true, user_id: "usr_login" });
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("login@example.com");
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("Renewlet Owner");
    consoleLog.mockRestore();
  });

  it("logs a failed login without the identifier that was typed", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.findUserByEmail.mockResolvedValue(null);

    const response = await login(loginRequest("typed-in-the-wrong-box@example.com"), writeEnvFixture())
      .catch((error: unknown) => toResponse(error));

    expect(response.status).toBe(400);
    expect(consoleLog).toHaveBeenCalledWith({ event: "login", ok: false });
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("typed-in-the-wrong-box@example.com");
    consoleLog.mockRestore();
  });

  it("logs a disabled account as a failed login and keeps it anonymous", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_banned", banned: 1 }));

    const response = await login(loginRequest("banned@example.com"), writeEnvFixture())
      .catch((error: unknown) => toResponse(error));

    expect(response.status).toBe(403);
    expect(consoleLog).toHaveBeenCalledWith({ event: "login", ok: false });
    consoleLog.mockRestore();
  });

  it("waits for the second factor before calling an MFA login resolved", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_mfa", email: "mfa@example.com" }));
    mocks.authenticatorMfaMethodsForUser.mockResolvedValue(["totp"]);

    await login(loginRequest("mfa@example.com"), writeEnvFixture());

    expect(consoleLog).not.toHaveBeenCalled();

    await mfaVerify(jsonRequest("/api/app/auth/mfa/verify", { ticketId: "mfa-ticket", method: "totp", code: "123456" }), writeEnvFixture());

    expect(consoleLog).toHaveBeenCalledWith({ event: "login", ok: true, user_id: "usr_mfa" });
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("mfa@example.com");
    consoleLog.mockRestore();
  });
});

describe("Cloudflare account last seen", () => {
  it("stamps the account on the first authenticated request after a login", async () => {
    const fixture = lastSeenEnvFixture({ session_last_seen_at: minutesAgo(1), user_last_seen_at: null });

    const auth = await requireAuth(sessionRequest(), fixture.env);

    expect(auth.user.id).toBe("usr_admin");
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]?.sql).toContain("UPDATE users SET last_seen_at");
    expect(fixture.writes[0]?.values[1]).toBe("usr_admin");
  });

  it("leaves a quarter of an hour between writes so reads stay reads", async () => {
    const fixture = lastSeenEnvFixture({ session_last_seen_at: minutesAgo(1), user_last_seen_at: minutesAgo(1) });

    await requireAuth(sessionRequest(), fixture.env);

    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("stamps session and account in one round trip once both values age out", async () => {
    const fixture = lastSeenEnvFixture({ session_last_seen_at: minutesAgo(16), user_last_seen_at: minutesAgo(16) });

    await requireAuth(sessionRequest(), fixture.env);

    expect(fixture.batch).toHaveBeenCalledTimes(1);
    expect(fixture.writes.map((write) => write.sql)).toEqual([
      "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
      "UPDATE users SET last_seen_at = ? WHERE id = ?",
    ]);
  });

  it("answers the request when the last seen write fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = lastSeenEnvFixture({ session_last_seen_at: minutesAgo(1), user_last_seen_at: null }, true);

    await expect(requireAuth(sessionRequest(), fixture.env)).resolves.toMatchObject({ user: { id: "usr_admin" } });
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ event: "last_seen_touch_failed" }));
    consoleError.mockRestore();
  });
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://renewlet.example${path}`, {
    method: "POST",
    headers: { "accept-language": "en-US", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function loginRequest(email: string): Request {
  return jsonRequest("/api/app/auth/login", { email, password: "password123" });
}

function sessionRequest(): Request {
  return new Request("https://renewlet.example/api/app/auth/session", {
    headers: { "cookie": "renewlet_session=session-token; renewlet_csrf=csrf-token", "x-renewlet-csrf": "csrf-token" },
  });
}

/** Login only needs D1 to accept the session insert and to report no Turnstile settings. */
function writeEnvFixture(): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(null),
        bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}) })),
      })),
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

function lastSeenEnvFixture(
  overrides: { session_last_seen_at: string; user_last_seen_at: string | null },
  failWrites = false,
): { env: Env; writes: Array<{ sql: string; values: unknown[] }>; batch: ReturnType<typeof vi.fn> } {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
    if (failWrites) throw new Error("D1_ERROR: no such column: last_seen_at: SQLITE_ERROR");
    for (const statement of statements) writes.push(statement);
    return [];
  });
  const env = {
    DB: {
      batch,
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => (
          sql.includes("FROM sessions JOIN users")
            ? { first: vi.fn().mockResolvedValue({ ...authRow(), ...overrides }) }
            : { sql: sql.trim(), values }
        )),
      })),
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
  return { env, writes, batch };
}

function authRow(): SessionAuthRow {
  return {
    ...userRow({ id: "usr_admin", email: "admin@example.com", name: "Admin", role: "admin" }),
    user_last_seen_at: null,
    session_id: "session-current",
    session_token_hash: "token-hash",
    session_csrf_token_hash: "token-hash",
    session_user_id: "usr_admin",
    session_expires_at: "2026-07-03T00:00:00.000Z",
    session_created_at: "2026-06-03T00:00:00.000Z",
    session_last_seen_at: "2026-06-03T00:00:00.000Z",
  };
}

function userRow(overrides: Partial<UserRow>): UserRow {
  return {
    id: "usr_user",
    email: "user@example.com",
    name: "User",
    role: "user",
    banned: 0,
    ban_reason: "",
    password_hash: "old-hash",
    reset_token_hash: null,
    reset_token_expires_at: null,
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}
