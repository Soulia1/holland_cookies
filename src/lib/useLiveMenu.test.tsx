// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.fn();
vi.mock("@/lib/api", () => ({ api: { menu: () => menu() } }));

const catalogue = {
  categories: [{
    id: "cookie-scoops", name: "Cookie Scoops",
    items: [{ id: "scoop-nutella-foil", categoryId: "cookie-scoops", name: "Scoop", price: 300,
      regularPrice: 300, discounted: false, available: true, choices: [] }],
  }],
};

describe("useLiveMenu", () => {
  beforeEach(async () => {
    menu.mockReset();
    vi.resetModules();
  });

  it("is loading until the catalogue arrives, then ready", async () => {
    menu.mockResolvedValue(catalogue);
    const { useLiveMenu } = await import("./liveMenu");
    const { result } = renderHook(() => useLiveMenu());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("not ready");
    expect(result.current.menu.products.get("scoop-nutella-foil")?.choices).toEqual([]);
  });

  it("reports a failed request instead of falling back to the printed menu, and can retry", async () => {
    menu.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(catalogue);
    const { useLiveMenu } = await import("./liveMenu");
    const { result } = renderHook(() => useLiveMenu());
    await waitFor(() => expect(result.current.status).toBe("error"));
    const failed = result.current;
    if (failed.status !== "error") throw new Error("not an error");
    act(() => failed.retry());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(menu).toHaveBeenCalledTimes(2);
  });
});
