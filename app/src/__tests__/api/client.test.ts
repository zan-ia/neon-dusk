import { describe, it, expect, vi } from "vitest";
import { ApiError, api } from "@/api/client";

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("api client", () => {
  it("should use VITE_API_BASE_URL as the base URL", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:3000");
    vi.resetModules();
    const { api: freshApi } = await import("@/api/client");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await freshApi.get("/health");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/health",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllEnvs();
  });

  it("should GET the path prefixed by the (empty) base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/health");

    expect(fetchMock).toHaveBeenCalledWith("/health", expect.objectContaining({ method: "GET" }));
  });

  it("should return the parsed JSON body on success", async () => {
    const payload = { status: "ok", uptime: 42 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const data = await api.get<typeof payload>("/health");

    expect(data).toEqual(payload);
  });

  it("should throw ApiError with status, code and message on error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: "NOT_FOUND", message: "Gig não encontrada" }, 404)),
    );

    const err = await api.get("/gigs/unknown").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Gig não encontrada",
    });
  });

  it("should fall back to defaults when the error body has no JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const err = await api.get("/health").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 500,
      code: "UNKNOWN_ERROR",
      message: "Request failed",
    });
  });

  it("should abort requests that outlive the 5s timeout", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its signal aborts (like the real one).
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = api.get("/health");
    const assertion = expect(promise).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
