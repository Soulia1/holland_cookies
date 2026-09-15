import { expect, request as newRequest, test, type APIRequestContext } from "@playwright/test";

/**
 * The API, attacked the way a browser console or a script can attack it.
 *
 * Real server, real (emulated) Firestore, and every request here is one a
 * visitor could send by hand. The backend suites prove the same rules from the
 * inside; this proves them through the HTTP surface the shop is served from, on
 * every browser project the commerce suite runs.
 */

const ADMIN_KEY = "e2e-admin-key-0123456789abcdefghijkl";
const RUN = Date.now().toString(36).slice(-5);
const headers = (baseURL: string) => ({ "x-requested-with": "Holland", origin: baseURL });

type Product = { id: string; price: number; available: boolean; isBundle?: boolean; choices?: unknown[] };

async function plainProduct(request: APIRequestContext): Promise<Product> {
  const menu = await (await request.get("/api/menu")).json();
  const items = menu.categories.flatMap((category: { items: Product[] }) => category.items) as Product[];
  // Under the free-delivery threshold the e2e server sets, so delivery is charged.
  return items.find((item) => item.available && !item.isBundle && !item.choices?.length && item.price < 500)!;
}

/**
 * POST, waiting out a strict limiter this file trips on purpose.
 *
 * The limits are production's (checkout: 20 per 10 minutes per address; promo
 * checks: 20 per 15 minutes), and this file sends more refused requests than
 * that within seconds. The e2e server sweeps the counters every two seconds (see
 * backend/test/e2e-server.js), so a 429 here means "wait for the sweep" and the
 * same request is sent again. What is asserted is still the status the server
 * gave the request itself; the limiter is exercised in tests/security.
 */
async function send(request: APIRequestContext, url: string, options: Parameters<APIRequestContext["post"]>[1]) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.post(url, options);
    if (response.status() !== 429 || attempt === 5) return response;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
}

function orderWith(request: APIRequestContext, baseURL: string, productId: string) {
  return (extra: Record<string, unknown> = {}) => send(request, "/api/orders", {
    headers: headers(baseURL),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Mallory", phone: "01012345678",
      fulfilment: "pickup", items: [{ productId, qty: 1 }], ...extra,
    },
  });
}

test("every admin route refuses a visitor with no session, a forged one, or the wrong key", async ({ request, baseURL }) => {
  const routes: [string, string][] = [
    ["GET", "/api/orders"], ["GET", "/api/orders/stats"], ["GET", "/api/orders/HC-1001"],
    ["GET", "/api/menu/admin/products"], ["GET", "/api/admin/promos"], ["GET", "/api/admin/users"],
    ["POST", "/api/menu/admin/products"], ["PATCH", "/api/menu/admin/products/anything"],
    ["DELETE", "/api/menu/admin/categories/anything"], ["POST", "/api/admin/promos"],
    ["PATCH", "/api/admin/settings"], ["PATCH", "/api/orders/HC-1001/status"],
    ["PATCH", "/api/orders/HC-1001/payment"], ["POST", "/api/admin/images"],
  ];
  for (const cookie of ["", `holland_admin_session=${"A".repeat(43)}`]) {
    for (const [method, url] of routes) {
      const response = await request.fetch(url, {
        method,
        headers: { ...headers(baseURL!), ...(cookie ? { cookie } : {}) },
        ...(method === "POST" || method === "PATCH" ? { data: {} } : {}),
      });
      expect(response.status(), `${method} ${url}${cookie ? " with a forged session" : ""}`).toBe(401);
    }
  }
  const wrongKey = await request.post("/api/admin/session", {
    headers: headers(baseURL!), data: { key: "not-the-admin-key-0123456789abcdef" },
  });
  expect(wrongKey.status()).toBe(401);
  expect(await wrongKey.text()).not.toContain(ADMIN_KEY);
});

test("an order is priced by the server, whatever the request claims about money", async ({ request, baseURL }) => {
  const product = await plainProduct(request);
  const order = orderWith(request, baseURL!, product.id);

  const forgeries: Record<string, unknown>[] = [
    { total: 1 }, { subtotal: 0 }, { discount: 500 }, { deliveryFee: 0 }, { delivery: 0 },
    { items: [{ productId: product.id, qty: 1, price: 0 }] },
    { items: [{ productId: product.id, qty: 1, unitPrice: -5 }] },
    { items: [{ productId: product.id, qty: -1 }] },
    { items: [{ productId: product.id, qty: 0 }] },
    { items: [{ productId: product.id, qty: 1.5 }] },
    { items: [{ productId: product.id, qty: 5000 }] },
    { paymentMethod: "card" },
    { fulfilment: "drone" },
  ];
  for (const forged of forgeries) {
    expect((await order(forged)).status(), JSON.stringify(forged)).toBe(400);
  }

  const unknown = await order({ items: [{ productId: "no-such-cookie", qty: 1 }] });
  expect(unknown.status()).toBe(400);
  expect((await unknown.json()).error).toBe("PRODUCT_MISSING");

  const stale = await order({ expectedTotal: 1 });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "PRICE_CHANGED", details: { currentTotal: product.price } });

  const noFee = await order({ fulfilment: "delivery", area: "nasr-city", address: "1 Street", expectedTotal: product.price });
  expect(noFee.status(), "delivery cannot be talked down to nothing").toBe(409);

  const honest = await order();
  expect(honest.status()).toBe(201);
  expect((await honest.json()).order.totals).toEqual({
    subtotal: product.price, discount: 0, delivery: 0, total: product.price,
  });
});

test("malformed promo codes and checkout keys are refused, never a server error", async ({ request, baseURL }) => {
  const product = await plainProduct(request);
  const order = orderWith(request, baseURL!, product.id);
  for (const code of ["<script>alert(1)</script>", "a/b", "../../orders", "__proto__", "NOT-A-REAL-CODE"]) {
    const validated = await send(request, "/api/admin/promos/validate", {
      headers: headers(baseURL!), data: { code, subtotal: 100 },
    });
    expect(validated.status(), `validate ${code}`).toBe(400);
    const placed = await order({ promoCode: code });
    expect(placed.status(), `order with ${code}`).toBe(400);
    expect((await placed.json()).error).toBe("INVALID_PROMO");
  }
  for (const idempotencyKey of ["not/a/valid/key", "__reserved-key__"]) {
    expect((await order({ idempotencyKey })).status(), idempotencyKey).toBe(400);
  }
});

test("bundle picks and options that do not fit the product are refused", async ({ request, baseURL }) => {
  const product = await plainProduct(request);
  const order = orderWith(request, baseURL!, product.id);
  const picks = await order({ items: [{ productId: product.id, qty: 1, selections: [{ group: 0, productId: product.id, quantity: 1 }] }] });
  expect(picks.status()).toBe(400);
  expect((await picks.json()).error).toBe("INVALID_SELECTION");
  const option = await order({ items: [{ productId: product.id, qty: 1, choice: "An invented flavour" }] });
  expect(option.status()).toBe(400);
  expect((await option.json()).error).toBe("INVALID_CHOICE");
});

test("text an admin typed is shown on the shop as text, never run as markup", async ({ page, baseURL }) => {
  const admin = await newRequest.newContext({ baseURL, extraHTTPHeaders: headers(baseURL!) });
  expect((await admin.post("/api/admin/session", { data: { key: ADMIN_KEY } })).ok()).toBeTruthy();
  const category = { id: `markup-${RUN}`, name: `Markup ${RUN}`, group: "cookies" };
  const name = `<img src=x onerror="window.__xss=1">Probe ${RUN}`;
  try {
    expect((await admin.post("/api/menu/admin/categories", { data: category })).status()).toBe(201);
    const created = await admin.post("/api/menu/admin/products", {
      data: {
        id: `markup-probe-${RUN}`, categoryId: category.id, name, price: 10,
        description: "<b>bold?</b><script>window.__xss=2</script>",
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    await page.goto("/menu/cookies", { waitUntil: "load" });
    await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(`#${category.id}`)).toContainText(name);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  } finally {
    await admin.delete(`/api/menu/admin/categories/${category.id}?withProducts=1`);
    await admin.dispose();
  }
});
