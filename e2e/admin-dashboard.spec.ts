import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { DEFAULT_AREAS } from "../shared/deliveryAreas.mjs";

/**
 * The admin dashboard, all the way round.
 *
 * ADMIN → DATABASE → STOREFRONT → CART → CASH ORDER → RECEIPT → ADMIN.
 *
 * Every step goes through the real dashboard UI or the real public pages, against
 * the real server and a real (emulated) Firestore. Nothing in the business path
 * is mocked. Where a step is checked through the API it is the same public or
 * admin endpoint the pages themselves call, used to prove what was stored.
 *
 * Runs on desktop Chromium, a Chromium phone and WebKit on an iPhone, so the
 * dashboard is exercised at phone width too. Everything created here is removed
 * afterwards and the shop settings are put back, so the specs that follow see
 * the seeded shop.
 */

const ADMIN_KEY = "e2e-admin-key-0123456789abcdefghijkl";
/**
 * The dashboard's own host (ADMIN_HOSTNAME in backend/test/e2e-server.js). The
 * shop is the project baseURL on 127.0.0.1, so the admin session cookie lives
 * here only: an admin call made through `page.request` must name this host.
 */
const ADMIN = "http://localhost:3100";
const DEFAULT_SETTINGS = { deliveryFee: 40, freeDeliveryOver: 600, acceptingOrders: true };

/** Unique per run, so a project re-running after a failure never collides with leftovers. */
const RUN = Date.now().toString(36).slice(-5);
const CATEGORY = { name: `Admin Loop ${RUN}`, nameAr: "قسم التجربة", id: `admin-loop-${RUN}` };
const PRODUCT = {
  name: `Loop Chunk Cookie ${RUN}`,
  id: `loop-chunk-cookie-${RUN}`,
  nameAr: "كوكيز شانك",
  description: "Brown butter dough, dark chocolate chunks.",
  descriptionAr: "عجينة زبدة محمصة وقطع شوكولاتة غامقة.",
};
const TWIN = `Loop, Chunk & Cookie ${RUN}`;
const RENAMED = `Loop Double Chunk ${RUN}`;
const BOX = { name: `Loop Box ${RUN}`, id: `loop-box-${RUN}` };
const CHOICE_ID = `loop-pick-${RUN}`;
const PROMOS = [`LOOP${RUN}`.toUpperCase(), `LOOPDATE${RUN}`.toUpperCase(), `LOOPFIX${RUN}`.toUpperCase()];
/** Kitchen notes as a customer might type them, with markup that has to stay text. */
const NOTE = `Ring twice, no nuts <img src=x onerror="window.__xss=1"> ${RUN}`;

const headers = (baseURL: string) => ({ "x-requested-with": "Holland", origin: baseURL });

async function adminApi(baseURL: string): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: headers(baseURL) });
  const login = await api.post("/api/admin/session", { data: { key: ADMIN_KEY } });
  expect(login.ok()).toBeTruthy();
  return api;
}

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

async function signIn(page: Page, path = "") {
  await page.goto(`${ADMIN}/`, { waitUntil: "load" });
  // The gate asks the server whether a session exists before it draws either the
  // key form or the dashboard. Counting the form while that answer was still out
  // found nothing, skipped signing in, and left the next page stuck on the gate
  // (seen on desktop WebKit, which is fast enough to land in that window).
  const keyForm = page.locator("#admin-key");
  await expect(keyForm.or(page.locator("main"))).toBeVisible({ timeout: 15_000 });
  if (await keyForm.count()) {
    await page.locator("#admin-key").fill(ADMIN_KEY);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator("#admin-key")).toHaveCount(0);
  }
  if (path) await page.goto(`${ADMIN}/${path}`, { waitUntil: "load" });
}

/** A small, valid PNG drawn in the page, a different colour each time. */
async function photo(page: Page, colour: string): Promise<Buffer> {
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext("2d")!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 24, 24);
    return canvas.toDataURL("image/png").split(",")[1];
  }, colour);
  return Buffer.from(base64, "base64");
}

async function publicMenu(page: Page) {
  const body = await (await page.request.get("/api/menu")).json();
  return body.categories as { id: string; name: string; group?: string; items: Record<string, any>[] }[];
}

async function publicProduct(page: Page, id: string) {
  return (await publicMenu(page)).flatMap((category) => category.items).find((item) => item.id === id);
}

/** Put lines straight into the cart the storefront keeps, then open checkout. */
async function checkoutWith(page: Page, lines: { productId: string; name: string; price: number; qty: number }[]) {
  await page.goto("/track", { waitUntil: "load" });
  // The cart provider writes its state to storage when it mounts, and `load` can
  // fire before React has committed. Writing first let that mount overwrite the
  // lines with an empty cart on a slow WebKit phone, so checkout opened empty.
  await ready(page);
  await page.waitForFunction(() => localStorage.getItem("holland-cart-v1") !== null);
  await page.evaluate((cart) => localStorage.setItem("holland-cart-v1", JSON.stringify(cart)), lines);
  await page.goto("/checkout", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".ed-summary")).toBeVisible();
}

async function fillDelivery(page: Page, phone: string) {
  await page.locator("#firstName").fill("Salma");
  await page.locator("#lastName").fill("Admin-Loop");
  await page.locator("#phone").fill(phone);
  await page.locator("#area").selectOption("nasr-city");
  await page.locator("#address").fill("12 Abbas El-Akkad Street");
}

/** The header's EN / AR switch — inside the phone menu when the header hides it. */
async function switchLanguage(page: Page, lang: "en" | "ar") {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = "";
  });
  const button = page.getByRole("button", { name: lang === "ar" ? "AR" : "EN", exact: true }).filter({ visible: true });
  // A modal still closing hides the page from role queries, so wait for any dialog to go first.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const inHeader = await button.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false);
  if (!inHeader) await page.getByRole("button", { name: "Open menu" }).filter({ visible: true }).click();
  await button.first().click();
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  if (await page.getByRole("button", { name: /close menu/i }).filter({ visible: true }).count()) {
    await page.getByRole("button", { name: /close menu/i }).filter({ visible: true }).click();
  }
}

const summaryRow = (page: Page, label: string) =>
  page.locator(".ed-srow", { has: page.getByText(label, { exact: true }) }).locator("span").last();

async function openEditor(page: Page, name: string) {
  await page.getByLabel("Search products").fill(name);
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#p-name")).toHaveValue(name);
  return dialog;
}

test.afterAll(async ({ baseURL }) => {
  const api = await adminApi(baseURL!);
  for (const id of [CHOICE_ID, BOX.id, `${PRODUCT.id}-2`, PRODUCT.id]) {
    await api.delete(`/api/menu/admin/products/${id}`);
  }
  await api.delete(`/api/menu/admin/categories/${CATEGORY.id}?withProducts=1`);
  for (const code of PROMOS) await api.delete(`/api/admin/promos/${code}`);
  await api.patch("/api/admin/settings", { data: DEFAULT_SETTINGS });
  await api.dispose();
});

// ------------------------------------------------------------- settings ----

test("settings are stored, survive a reload, and checkout and the server obey them", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const api = await adminApi(baseURL!);
  try {
    const menu = await publicMenu(page);
    const product = menu.flatMap((c) => c.items).find((item) => item.available && !item.isBundle)!;

    await signIn(page, "settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // Nothing editable that the server would throw away.
    for (const gone of ["Store name", "Store contact email", "Pickup address", "Pickup hours"]) {
      await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText("Email provider not configured")).toBeVisible();
    await expect(page.getByRole("button", { name: /verify connection|send test/i })).toHaveCount(0);

    // A bad value is refused in words and nothing is sent.
    await page.locator("#delivery-fee").fill("-3");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("alert")).toHaveText("The delivery fee must be a number, zero or more.");

    await page.locator("#delivery-fee").fill("45");
    await page.locator("#free-delivery-over").fill("0");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    // Mandatory: a reload shows what the server stored, not what was typed.
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#delivery-fee")).toHaveValue("45");
    await expect(page.locator("#free-delivery-over")).toHaveValue("0");
    await expect(page.locator("#accepting-orders")).toBeChecked();

    // Checkout displays the new fee, and the server charges it.
    await checkoutWith(page, [{ productId: product.id, name: product.name, price: product.price, qty: 1 }]);
    await expect(summaryRow(page, "Delivery")).toHaveText("45.00 EGP");
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText(`${(product.price + 45).toFixed(2)} EGP`);

    // Free delivery starts at exactly the threshold: this basket's subtotal is
    // free, a piastre more is not. The backend suite proves the server agrees.
    for (const [threshold, fee] of [[product.price, "0.00 EGP"], [product.price + 0.01, "45.00 EGP"]] as const) {
      await signIn(page, "settings");
      await page.locator("#free-delivery-over").fill(String(threshold));
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
      await checkoutWith(page, [{ productId: product.id, name: product.name, price: product.price, qty: 1 }]);
      await expect(summaryRow(page, "Delivery")).toHaveText(fee);
    }

    // Accepting orders off: the shop says so, the button is off, the server refuses.
    await signIn(page, "settings");
    await page.locator("#accepting-orders").uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#accepting-orders")).not.toBeChecked();

    await page.goto("/checkout", { waitUntil: "load" });
    await ready(page);
    await expect(page.getByRole("alert").filter({ hasText: "We are not taking orders" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Place order" })).toBeDisabled();
    const refused = await page.request.post("/api/orders", {
      headers: headers(baseURL!),
      data: {
        idempotencyKey: crypto.randomUUID(), firstName: "Closed", phone: "01012345678",
        fulfilment: "pickup", items: [{ productId: product.id, qty: 1 }],
      },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe("CLOSED");

    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await page.getByRole("button", { name: "Open cart" }).click();
    await expect(page.locator(".cart-closed")).toHaveText("We are not taking orders at the moment. Please try again later.");
    await page.keyboard.press("Escape");

    // Back on: a pickup order goes through with no delivery fee.
    await signIn(page, "settings");
    await page.locator("#accepting-orders").check();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    await page.goto("/checkout", { waitUntil: "load" });
    await ready(page);
    await page.locator("#firstName").fill("Pickup");
    await page.locator("#phone").fill("01012345678");
    await page.getByRole("radio", { name: "Pickup" }).click();
    await expect(summaryRow(page, "Delivery")).toHaveText("0.00 EGP");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".rcpt-total-value")).toHaveText(`${product.price.toFixed(2)} EGP`);
    await expect(page.locator(".rcpt-meta")).toContainText("Cash on pickup");
  } finally {
    await api.patch("/api/admin/settings", { data: DEFAULT_SETTINGS });
    await api.dispose();
  }
});

/*
 * Delivery areas: typed in the dashboard, offered by checkout, enforced by the
 * server.
 *
 * The seeded list is Cairo and Giza, which is nearly forty neighbourhoods, so
 * the button that fills them in is part of the feature rather than a
 * convenience — nobody types forty rows correctly. What this walk is really
 * guarding is the id: an order stores the area's id, so a list that is edited
 * must keep the ids of the areas that stay.
 */
test("delivery areas are edited in the dashboard and are exactly what checkout offers", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const api = await adminApi(baseURL!);
  const TYPED = "Test Area E2E";
  try {
    await signIn(page, "settings");
    const rows = page.getByRole("list", { name: "Delivery areas" }).getByRole("listitem");
    await expect(rows).toHaveCount(DEFAULT_AREAS.length);

    // Remove the first seeded area and type one of our own.
    const removed = DEFAULT_AREAS[0];
    await expect(rows.first().getByLabel("Area 1 name")).toHaveValue(removed.name);
    await rows.first().getByRole("button", { name: "Remove area 1" }).click();
    await expect(rows).toHaveCount(DEFAULT_AREAS.length - 1);

    await page.getByRole("button", { name: "Add area", exact: true }).click();
    const last = rows.last();
    await last.getByLabel(`Area ${DEFAULT_AREAS.length} name`).fill(TYPED);
    await last.getByLabel(`Area ${DEFAULT_AREAS.length} governorate`, { exact: true }).fill("Cairo");
    await last.getByLabel(`Area ${DEFAULT_AREAS.length} delivery price (EGP)`).fill("15");
    // Giza is a longer drive, and one area is delivered free. Zero has to be
    // stored as a price rather than read as "nothing typed".
    const rowFor = (name: string) => rows.filter({ has: page.locator(`input[value="${name}"]`) });
    await rowFor("Haram").getByLabel(/delivery price/).fill("70");
    await rowFor("Maadi").getByLabel(/delivery price/).fill("0");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    // What the server stored, not what was typed: the id was made from the
    // name, because a hand-typed one with a capital in it is refused.
    await page.reload({ waitUntil: "load" });
    const saved = await (await page.request.get("/api/admin/settings")).json();
    const ids = saved.settings.areas.map((area: { id: string }) => area.id);
    expect(ids).toContain("test-area-e2e");
    expect(ids).not.toContain(removed.id);
    const feeOf = (id: string) =>
      saved.settings.areas.find((area: { id: string }) => area.id === id)?.fee;
    expect(feeOf("test-area-e2e")).toBe(15);
    expect(feeOf("haram")).toBe(70);
    expect(feeOf("maadi")).toBe(0);
    // An area nobody priced is stored as "no price", not as zero.
    expect(feeOf("zamalek")).toBe(null);

    // Checkout offers exactly that list, grouped by governorate. With a line in
    // the cart: an empty checkout is a "nothing to check out" page with no form
    // on it at all, and asserting about a select that is not there passes for
    // the wrong reason as readily as it fails.
    const menu = await publicMenu(page);
    const sellable = menu.flatMap((c) => c.items)
      .find((item) => item.available && !item.isBundle && !item.choices?.length)!;
    await checkoutWith(page, [
      { productId: sellable.id, name: sellable.name, price: sellable.price, qty: 1 },
    ]);
    const area = page.locator("#area");
    await expect(area.locator(`option[value="${removed.id}"]`)).toHaveCount(0);
    await expect(area.locator('option[value="test-area-e2e"]')).toHaveCount(1);
    expect(await area.locator("optgroup").evaluateAll(
      (groups) => groups.map((group) => (group as HTMLOptGroupElement).label),
    )).toEqual(["Cairo", "Giza"]);

    // Each area names its own price in the select, and the summary charges it.
    await expect(area.locator('option[value="haram"]')).toHaveText("Haram — 70.00 EGP");
    await expect(area.locator('option[value="maadi"]')).toHaveText("Maadi — 0.00 EGP");
    await expect(area.locator('option[value="zamalek"]')).toHaveText("Zamalek — 40.00 EGP");

    await area.selectOption("haram");
    await expect(summaryRow(page, "Delivery")).toHaveText("70.00 EGP");
    await area.selectOption("maadi");
    await expect(summaryRow(page, "Delivery")).toHaveText("0.00 EGP");
    await area.selectOption("zamalek");
    await expect(summaryRow(page, "Delivery")).toHaveText("40.00 EGP");

    // And the server refuses the one that was removed, whatever a client sends.
    const refused = await page.request.post("/api/orders", {
      headers: headers(baseURL!),
      data: {
        idempotencyKey: crypto.randomUUID(), firstName: "Gone", phone: "01012345678",
        fulfilment: "delivery", area: removed.id, address: "1 Street",
        items: [{ productId: "special-dubai-chocolate-cookie", qty: 1, choice: "Regular" }],
      },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe("INVALID_AREA");

    // One button puts the whole of Cairo and Giza back, without disturbing the
    // row that was typed by hand.
    await signIn(page, "settings");
    await page.getByRole("button", { name: "Add all Cairo & Giza areas" }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    const restored = await (await page.request.get("/api/admin/settings")).json();
    const back = restored.settings.areas.map((entry: { id: string }) => entry.id);
    for (const entry of DEFAULT_AREAS) expect(back).toContain(entry.id);
    expect(back).toContain("test-area-e2e");
    // Nothing was added twice.
    expect(new Set(back).size).toBe(back.length);
  } finally {
    await api.patch("/api/admin/settings", { data: { areas: DEFAULT_AREAS } });
    await api.dispose();
  }
});

// --------------------------------------------------------- the whole loop ----

test("a product made in the dashboard is sold, edited, sold out, bundled and deleted", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const phone = `010${String(Date.now()).slice(-8)}`;

  // ------------------------------------------------ dashboard: create ----
  await signIn(page, "menu");
  const photoA = await photo(page, "#8b4513");
  const photoB = await photo(page, "#2e8b57");
  await expect(page.getByLabel("Search products")).toBeVisible();

  await page.getByRole("button", { name: "New category" }).click();
  await page.locator("#new-category-name").fill(CATEGORY.name);
  await page.locator("#new-category-name-ar").fill(CATEGORY.nameAr);
  await page.locator("#new-category-group").selectOption("cookies");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Created “${CATEGORY.name}”`);

  await page.getByRole("button", { name: "New product" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#p-cat").selectOption(CATEGORY.id);
  await dialog.locator("#p-name").fill(PRODUCT.name);
  await expect(dialog.getByText(`Saved as “${PRODUCT.id}”`)).toBeVisible();

  // Clear errors before anything is sent: no price, a negative one, a discount over 100%.
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter a price.");
  await dialog.locator("#p-price").fill("-5");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The price must be a number, zero or more.");
  await dialog.locator("#p-price").fill("100");
  await dialog.getByRole("checkbox", { name: "Discount this product" }).check();
  await dialog.locator("#p-dtype").selectOption("percent");
  await dialog.locator("#p-dvalue").fill("150");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A percentage discount must be below 100%.");
  await dialog.locator("#p-dvalue").fill("10");
  await expect(dialog.getByText("Sells for 90 EGP")).toBeVisible();

  await dialog.locator("#p-name-ar").fill(PRODUCT.nameAr);
  await dialog.locator("#p-desc").fill(PRODUCT.description);
  await dialog.locator("#p-desc-ar").fill(PRODUCT.descriptionAr);
  await dialog.locator("#p-image").setInputFiles({ name: "chunk.png", mimeType: "image/png", buffer: photoA });
  await expect(dialog.getByTestId("product-photo")).toHaveAttribute("src", /^\/api\/images\/[a-f0-9]{32}\.(webp|jpg|png)$/);
  await expect(dialog.getByRole("checkbox", { name: "Available to order" })).toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("p[role=status]")).toContainText(`Added “${PRODUCT.name}”`);

  // The same name again is numbered, not refused; a hand-typed taken id is refused.
  await page.getByRole("button", { name: "New product" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#p-cat").selectOption(CATEGORY.id);
  await dialog.locator("#p-name").fill(TWIN);
  await dialog.locator("#p-price").fill("10");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Added “${TWIN}”`);
  expect((await publicProduct(page, `${PRODUCT.id}-2`))?.name).toBe(TWIN);

  await page.getByRole("button", { name: "New product" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#p-cat").selectOption(CATEGORY.id);
  await dialog.locator("#p-id").fill(PRODUCT.id);
  await dialog.locator("#p-name").fill("Somebody Else's Cookie");
  await dialog.locator("#p-price").fill("10");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That product id is taken.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await publicProduct(page, PRODUCT.id))?.name, "the taken id was not overwritten").toBe(PRODUCT.name);

  // Deleting asks first.
  page.once("dialog", (confirm) => confirm.accept());
  await page.getByRole("button", { name: `Delete ${TWIN}`, exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Deleted “${TWIN}”`);
  expect(await publicProduct(page, `${PRODUCT.id}-2`)).toBeUndefined();

  // ------------------------------------------------------------ database ----
  const category = (await publicMenu(page)).find((entry) => entry.id === CATEGORY.id)!;
  expect(category, "the new category is on the public menu").toBeTruthy();
  expect(category.group).toBe("cookies");
  const stored = await publicProduct(page, PRODUCT.id);
  expect(stored).toMatchObject({
    name: PRODUCT.name, nameAr: PRODUCT.nameAr, description: PRODUCT.description,
    descriptionAr: PRODUCT.descriptionAr, price: 90, regularPrice: 100, discounted: true, available: true,
  });
  const firstImage: string = stored!.image;
  expect(firstImage).toMatch(/^\/api\/images\//);

  // ---------------------------------------------------------- storefront ----
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await expect(page.getByRole("heading", { name: CATEGORY.name, level: 2 })).toBeVisible();
  const row = page.locator(`#${CATEGORY.id} .menu-item-open`, { hasText: PRODUCT.name }).first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.click();
  let detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: PRODUCT.name })).toBeVisible();
  await expect(detail).toContainText(PRODUCT.description);
  await expect(detail).toContainText("90.00 EGP");
  await expect(detail.locator("img").first()).toHaveAttribute("src", firstImage);
  await detail.locator(".menu-detail-add").click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.keyboard.press("Escape");

  // The same product in Arabic, switched the way a customer switches.
  await switchLanguage(page, "ar");
  await expect(page.locator(`#${CATEGORY.id}`)).toContainText(PRODUCT.nameAr);
  await expect(page.locator(`#${CATEGORY.id}`)).toContainText(CATEGORY.nameAr);
  await switchLanguage(page, "en");

  // -------------------------------------------------- cart → checkout ----
  await page.goto("/checkout", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".ed-summary")).toContainText(PRODUCT.name);
  await expect(page.locator(".ed-sum-price").first()).toHaveText("90.00 EGP");
  await fillDelivery(page, phone);
  await expect(summaryRow(page, "Delivery")).toHaveText("40.00 EGP");
  await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("130.00 EGP");
  // A double tap is one order.
  await page.getByRole("button", { name: "Place order" }).dblclick();

  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  const reference = (await page.locator(".rcpt-barcode-text").innerText()).trim();
  expect(reference).toMatch(/^HC-\d+$/);
  await expect(page.locator(".rcpt-total-value")).toHaveText("130.00 EGP");
  await expect(page.locator(".rcpt-meta")).toContainText("Cash on delivery");
  await expect(page.locator(".rcpt-lines").first()).toContainText(PRODUCT.name);
  await expect(page.locator(".cart-badge")).toHaveCount(0);

  // ------------------------------------------------------ back to admin ----
  await signIn(page, `orders?q=${phone}`);
  await expect(page.locator(".adm-sub")).toHaveText(new RegExp(`· 1 match for “${phone}”`));
  const reflink = page.getByRole("link", { name: reference, exact: true }).filter({ visible: true });
  await expect(reflink).toBeVisible();

  // The fulfilment filter is applied by the server.
  const typeFilter = page.getByLabel("Filter by fulfilment type");
  await typeFilter.selectOption("pickup");
  await expect(page.getByText(`No orders found matching “${phone}”.`)).toBeVisible();
  await typeFilter.selectOption("delivery");
  await expect(reflink).toBeVisible();
  await typeFilter.selectOption("");
  await expect(page.getByText("Today’s fulfilments")).toHaveCount(0);

  await reflink.click();
  const orderDialog = page.getByRole("dialog");
  await expect(orderDialog.getByRole("heading", { name: reference })).toBeVisible();
  await expect(orderDialog).toContainText(PRODUCT.name);
  await expect(orderDialog).toContainText("Cash on delivery");
  await expect(orderDialog).toContainText("Cash not yet collected");
  await expect(orderDialog).toContainText("130 EGP");
  await expect(orderDialog).toContainText("12 Abbas El-Akkad Street");
  await expect(orderDialog).not.toContainText("Confirmation email");
  await orderDialog.getByRole("button", { name: "Mark as confirmed" }).click();
  await expect(orderDialog.getByRole("button", { name: "Mark as baking" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(orderDialog).toHaveCount(0);

  for (const status of ["baking", "in_transit", "completed"]) {
    const moved = await page.request.patch(`${ADMIN}/api/orders/${reference}/status`, { headers: headers(ADMIN), data: { status } });
    expect(moved.ok()).toBeTruthy();
  }
  await page.reload({ waitUntil: "load" });
  const collect = page.getByRole("button", { name: "Mark cash collected" }).filter({ visible: true });
  await collect.click();
  const collected = page.getByRole("button", { name: "Cash collected" }).filter({ visible: true });
  await expect(collected).toBeVisible();
  expect((await (await page.request.get(`${ADMIN}/api/orders/${reference}`)).json()).order.paymentStatus).toBe("paid");
  await collected.click();
  await page.getByRole("menuitem", { name: "Mark cash not collected" }).click();
  await expect(collect).toBeVisible();

  await page.goto(`${ADMIN}/orders/${reference}`, { waitUntil: "load" });
  await expect(page.getByRole("heading", { name: reference })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Invalid Date");
  await page.goto(`${ADMIN}/users`, { waitUntil: "load" });
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Invalid Date");

  // ----------------------------------------------------------- edit ----
  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  dialog = await openEditor(page, PRODUCT.name);
  await dialog.locator("#p-name").fill(RENAMED);
  await dialog.locator("#p-price").fill("120");
  await dialog.locator("#p-image").setInputFiles({ name: "double.png", mimeType: "image/png", buffer: photoB });
  await expect(dialog.getByTestId("product-photo")).not.toHaveAttribute("src", firstImage);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("p[role=status]")).toContainText(`Saved “${RENAMED}”`);

  const edited = await publicProduct(page, PRODUCT.id);
  expect(edited).toMatchObject({ name: RENAMED, price: 108, regularPrice: 120 });
  expect(edited!.image).not.toBe(firstImage);

  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(`#${CATEGORY.id}`)).not.toContainText(PRODUCT.name);
  const editedRow = page.locator(`#${CATEGORY.id} .menu-item-open`, { hasText: RENAMED }).first();
  await editedRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await editedRow.click();
  detail = page.getByRole("dialog");
  await expect(detail).toContainText("108.00 EGP");
  await expect(detail.locator("img").first()).toHaveAttribute("src", edited!.image);
  await detail.locator(".menu-detail-add").click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.keyboard.press("Escape");

  // ------------------------------------------------------ sold out ----
  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  dialog = await openEditor(page, RENAMED);
  await dialog.getByRole("checkbox", { name: "Available to order" }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await publicProduct(page, PRODUCT.id))!.available).toBe(false);

  // The menu says so, and offers no way to add it.
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  const soldOutSection = page.locator(`#${CATEGORY.id}`);
  await expect(soldOutSection).toContainText(RENAMED);
  await expect(soldOutSection).toContainText("Sold out");
  await expect(page.getByRole("button", { name: `Add ${RENAMED} to cart` })).toHaveCount(0);

  await page.goto("/checkout", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".ed-sum-item.is-gone")).toContainText(RENAMED);
  await expect(page.getByRole("button", { name: "Place order" })).toBeDisabled();
  const soldOut = await page.request.post("/api/orders", {
    headers: headers(baseURL!),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Sneaky", phone, fulfilment: "pickup",
      items: [{ productId: PRODUCT.id, qty: 1 }],
    },
  });
  expect(soldOut.status(), "a disabled button is not the only thing in the way").toBe(409);

  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  dialog = await openEditor(page, RENAMED);
  await dialog.getByRole("checkbox", { name: "Available to order" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto("/checkout", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".ed-sum-item.is-gone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();

  // The order is charged the edited price, not the one it was first sold at, and
  // the customer's notes reach the kitchen as typed: markup included, as text.
  await page.getByRole("radio", { name: "Pickup" }).click();
  await page.locator("#firstName").fill("Edited");
  await page.locator("#phone").fill(phone);
  await page.locator("#notes").fill(NOTE);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rcpt-total-value")).toHaveText("108.00 EGP");
  await expect(page.locator(".rcpt-meta")).toContainText(phone);
  const editedReference = (await page.locator(".rcpt-barcode-text").innerText()).trim();
  const editedOrder = (await (await page.request.get(`${ADMIN}/api/orders/${editedReference}`)).json()).order;
  expect(editedOrder.items[0]).toMatchObject({ productId: PRODUCT.id, name: RENAMED, nameAr: PRODUCT.nameAr, unitPrice: 108 });
  expect(editedOrder.delivery.notes).toBe(NOTE);
  await page.goto(`${ADMIN}/orders/${editedReference}`, { waitUntil: "load" });
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // A fixed amount off: refused at the full price, then sold at the difference.
  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  dialog = await openEditor(page, RENAMED);
  await dialog.locator("#p-dtype").selectOption("fixed");
  await dialog.locator("#p-dvalue").fill("120");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A fixed discount must be less than the price.");
  await dialog.locator("#p-dvalue").fill("20");
  await expect(dialog.getByText("Sells for 100 EGP")).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await publicProduct(page, PRODUCT.id)).toMatchObject({ price: 100, regularPrice: 120, discounted: true });

  // -------------------------------------------------------- bundles ----
  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  await page.getByRole("button", { name: "New product" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#p-cat").selectOption(CATEGORY.id);
  await dialog.locator("#p-name").fill(BOX.name);
  await dialog.locator("#p-price").fill("200");
  await dialog.getByRole("checkbox", { name: "This is a bundle" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A fixed bundle needs at least one product inside it.");
  await dialog.getByRole("button", { name: "Add product" }).click();
  await dialog.getByLabel("Component 1 product").selectOption(PRODUCT.id);
  await dialog.getByLabel("Component 1 quantity").fill("2");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await publicProduct(page, BOX.id)).toMatchObject({
    isBundle: true, bundleType: "fixed", price: 200,
    components: [{ productId: PRODUCT.id, quantity: 2, name: RENAMED }],
  });

  // A box is sold out while a cookie inside it is: on the menu, and at the server.
  const sellCookie = (available: boolean) => page.request.patch(`${ADMIN}/api/menu/admin/products/${PRODUCT.id}`, {
    headers: headers(ADMIN), data: { available },
  });
  expect((await sellCookie(false)).ok()).toBeTruthy();
  expect((await publicProduct(page, BOX.id))!.available).toBe(false);
  const boxRefused = await page.request.post("/api/orders", {
    headers: headers(baseURL!),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Box", phone, fulfilment: "pickup",
      items: [{ productId: BOX.id, qty: 1 }],
    },
  });
  expect(boxRefused.status(), "a box with a sold-out cookie inside").toBe(409);
  expect((await sellCookie(true)).ok()).toBeTruthy();
  expect((await publicProduct(page, BOX.id))!.available).toBe(true);

  const plain = (await publicMenu(page)).flatMap((c) => c.items)
    .find((item) => item.available && !item.isBundle && item.id !== PRODUCT.id)!;
  const choice = await page.request.post(`${ADMIN}/api/menu/admin/products`, {
    headers: headers(ADMIN),
    data: {
      id: CHOICE_ID, categoryId: CATEGORY.id, name: `Loop Pick Two ${RUN}`, price: 150,
      isBundle: true, bundleType: "choice",
      groups: [{
        label: "Your cookies", labelAr: "", choose: 2, allowRepeats: false,
        options: [{ productId: PRODUCT.id, surcharge: 5 }, { productId: plain.id, surcharge: 0 }],
      }],
    },
  });
  expect(choice.status(), await choice.text()).toBe(201);

  const bundleOrder = await page.request.post("/api/orders", {
    headers: headers(baseURL!),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Bundle", phone, fulfilment: "pickup",
      items: [
        { productId: BOX.id, qty: 1 },
        { productId: CHOICE_ID, qty: 2, selections: [
          { group: 0, productId: PRODUCT.id, quantity: 1 }, { group: 0, productId: plain.id, quantity: 1 },
        ] },
      ],
    },
  });
  expect(bundleOrder.status(), await bundleOrder.text()).toBe(201);
  const bundled = (await bundleOrder.json()).order;
  expect(bundled.totals.total).toBe(200 + 155 * 2);

  const cheated = await page.request.post("/api/orders", {
    headers: headers(baseURL!),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Bundle", phone, fulfilment: "pickup",
      items: [{ productId: CHOICE_ID, qty: 1, selections: [{ group: 0, productId: plain.id, quantity: 2 }] }],
    },
  });
  expect(cheated.status()).toBe(400);

  await page.goto(`${ADMIN}/orders/${bundled.reference}`, { waitUntil: "load" });
  const items = page.locator("section", { has: page.getByRole("heading", { name: "Items" }) });
  await expect(items).toContainText(BOX.name);
  await expect(items).toContainText(`Loop Pick Two ${RUN}`);
  await expect(items.getByText("Bundle", { exact: true })).toHaveCount(2);
  await expect(items).toContainText(RENAMED);
  await expect(items).toContainText(plain.name);

  // A product a bundle holds cannot be deleted out from under it — said, not swallowed.
  await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
  await page.getByLabel("Search products").fill(RENAMED);
  page.once("dialog", (confirm) => confirm.accept());
  await page.getByRole("button", { name: `Delete ${RENAMED}`, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This product is inside a bundle");
  expect(await publicProduct(page, PRODUCT.id)).toBeTruthy();

  // -------------------------------------------------------- delete ----
  expect((await page.request.delete(`${ADMIN}/api/menu/admin/products/${CHOICE_ID}`, { headers: headers(ADMIN) })).status()).toBe(204);
  await page.getByLabel("Search products").fill("");
  for (const name of [BOX.name, RENAMED]) {
    page.once("dialog", (confirm) => confirm.accept());
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await expect(page.locator("p[role=status]")).toContainText(`Deleted “${name}”`);
  }
  expect(await publicProduct(page, PRODUCT.id)).toBeUndefined();
  expect(await publicProduct(page, BOX.id)).toBeUndefined();
  const ghost = await page.request.post("/api/orders", {
    headers: headers(baseURL!),
    data: {
      idempotencyKey: crypto.randomUUID(), firstName: "Ghost", phone, fulfilment: "pickup",
      items: [{ productId: PRODUCT.id, qty: 1 }],
    },
  });
  expect(ghost.status(), "a deleted product cannot be ordered by hand").toBe(400);
  expect((await ghost.json()).error).toBe("PRODUCT_MISSING");

  await page.getByRole("button", { name: `Delete the ${CATEGORY.name} category` }).click();
  const confirmCategory = page.getByRole("dialog");
  await expect(confirmCategory).toContainText("This category is empty");
  await confirmCategory.getByRole("button", { name: "Delete category" }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Deleted “${CATEGORY.name}”`);
  expect((await publicMenu(page)).find((entry) => entry.id === CATEGORY.id)).toBeUndefined();

  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await expect(page.getByRole("heading", { name: CATEGORY.name })).toHaveCount(0);
  await expect(page.getByText(RENAMED)).toHaveCount(0);
});

// ----------------------------------------------------------------- promos ----

test("promo codes are created with and without an expiry, used at checkout, switched and deleted", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const [plainCode, datedCode, fixedCode] = PROMOS;
  const validate = async (code: string, subtotal = 100) =>
    page.request.post("/api/admin/promos/validate", { headers: headers(baseURL!), data: { code, subtotal } });
  const card = (code: string) => page.locator('[data-slot="card"]', { has: page.getByText(code, { exact: true }) });

  await signIn(page, "promos");
  const create = page.getByRole("button", { name: "Create code" });
  const message = page.locator("form p.text-sm");

  await create.click();
  await expect(message).toHaveText("Enter a code.");
  await page.getByPlaceholder("CODE (e.g. WELCOME10)").fill(plainCode);
  await page.getByPlaceholder("Discount % (e.g. 10)").fill("150");
  await create.click();
  await expect(message).toHaveText("A percentage discount must be below 100.");
  await page.getByPlaceholder("Discount % (e.g. 10)").fill("10");
  await page.locator('input[type="date"]').fill("2001-01-01");
  await create.click();
  await expect(message).toHaveText("That expiry date has already passed.");

  // No expiry: nothing is sent for it.
  await page.locator('input[type="date"]').fill("");
  await create.click();
  await expect(message).toHaveText("✓ Promo code created.");
  await expect(card(plainCode).getByText("Active", { exact: true })).toBeVisible();

  // With an expiry: the picked day becomes a timestamp the server accepts.
  await page.getByPlaceholder("CODE (e.g. WELCOME10)").fill(datedCode);
  await page.getByPlaceholder("Discount % (e.g. 10)").fill("20");
  await page.locator('input[type="date"]').fill("2099-12-31");
  await create.click();
  await expect(message).toHaveText("✓ Promo code created.");
  await expect(card(datedCode)).toContainText("Expires");

  await page.getByPlaceholder("CODE (e.g. WELCOME10)").fill(fixedCode);
  await page.getByRole("combobox").first().selectOption("fixed");
  await page.getByPlaceholder("Amount off in EGP").fill("25");
  await create.click();
  await expect(message).toHaveText("✓ Promo code created.");

  expect(await (await validate(plainCode)).json()).toMatchObject({ code: plainCode, discount: 10 });
  expect(await (await validate(datedCode)).json()).toMatchObject({ code: datedCode, discount: 20 });
  expect(await (await validate(fixedCode)).json()).toMatchObject({ code: fixedCode, discount: 25 });

  // Used at checkout: the server applies it and the receipt shows it.
  const product = (await publicMenu(page)).flatMap((c) => c.items).find((item) => item.available && !item.isBundle)!;
  await checkoutWith(page, [{ productId: product.id, name: product.name, price: product.price, qty: 2 }]);
  await page.locator("#promo").fill(datedCode.toLowerCase());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".ed-promo-msg.ok")).toContainText(datedCode);
  const subtotal = product.price * 2;
  const discount = Math.round(subtotal * 0.2 * 100) / 100;
  await page.getByRole("radio", { name: "Pickup" }).click();
  await page.locator("#firstName").fill("Promo");
  await page.locator("#phone").fill("01012345678");
  await expect(page.locator(".ed-srow.total span:last-child")).toHaveText(`${(subtotal - discount).toFixed(2)} EGP`);

  // The price moves while the customer is on the page. The server refuses the
  // stale total; the page re-prices, checks the code again against the new
  // subtotal, and the second attempt goes through at the new figure.
  const admin = await adminApi(baseURL!);
  try {
    const moved = await admin.patch(`/api/menu/admin/products/${product.id}`, { data: { price: product.regularPrice + 10 } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    const newSubtotal = (await publicProduct(page, product.id))!.price * 2;
    const newTotal = newSubtotal - Math.round(newSubtotal * 0.2 * 100) / 100;
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Prices changed" })).toBeVisible();
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText(`${newTotal.toFixed(2)} EGP`);
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".rcpt-total-value")).toHaveText(`${newTotal.toFixed(2)} EGP`);
    await expect(page.locator(".rcpt-lines").nth(1)).toContainText(datedCode);
  } finally {
    await admin.patch(`/api/menu/admin/products/${product.id}`, { data: { price: product.regularPrice } });
    await admin.dispose();
  }

  // Disable, enable, delete — each one read back from the server.
  await signIn(page, "promos");
  await card(plainCode).getByRole("button", { name: "Disable" }).click();
  await expect(card(plainCode).getByText("Inactive", { exact: true })).toBeVisible();
  expect((await validate(plainCode)).status()).toBe(400);
  await card(plainCode).getByRole("button", { name: "Enable" }).click();
  await expect(card(plainCode).getByText("Active", { exact: true })).toBeVisible();
  expect((await validate(plainCode)).status()).toBe(200);

  for (const code of PROMOS) {
    page.once("dialog", (confirm) => confirm.accept());
    await card(code).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(card(code)).toHaveCount(0);
    expect((await validate(code)).status()).toBe(400);
  }
});

// ------------------------------------------------------------- responsive ----

test("the dashboard fits a phone, a tablet and a desktop without sideways scrolling", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const path of ["", "orders", "menu", "promos", "settings", "users"]) {
      await page.goto(`${ADMIN}/${path}`, { waitUntil: "load" });
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `/${path} at ${viewport.width}px scrolls sideways`).toBeLessThanOrEqual(1);
    }

    // The editor's Save stays reachable however long the form is.
    await page.goto(`${ADMIN}/menu`, { waitUntil: "load" });
    await page.getByRole("button", { name: "New product" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "This is a bundle" }).check();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
});
