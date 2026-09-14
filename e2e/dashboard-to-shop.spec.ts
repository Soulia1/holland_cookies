import { expect, request, test, type Page } from "@playwright/test";

/**
 * A product added in the dashboard, all the way to a customer's receipt.
 *
 * This exists because that path was broken in production while every other
 * suite passed. The dashboard asked for a hand-typed product id; anything with a
 * capital or a space was refused with a bare "Check the fields.", so the product
 * was never saved and the shop had nothing to show. And a category created in
 * the dashboard had no page on the storefront at all. Each half looked fine on
 * its own — the dashboard's form, the server's validation, the menu page — and
 * only a test that walks the whole way through catches the seam.
 *
 * Real browser, real server, real (emulated) Firestore. Nothing is mocked.
 * Everything created here is deleted afterwards, so the specs that follow see
 * the seeded menu.
 */

const ADMIN_KEY = "e2e-admin-key-0123456789abcdefghijkl";
const CATEGORY = { id: "seasonal-specials-e2e", name: "Seasonal Specials E2E", nameAr: "موسمي" };
const PRODUCT = {
  name: "Pistachio Crunch Cookie",
  description: "A crunchy pistachio cookie, baked this morning.",
  price: "85",
};
/** Makes the same id as PRODUCT, so it must be saved as `…-2` rather than refused. */
const TWIN = "Pistachio, Crunch & Cookie";

// An 8×8 PNG, enough for the dashboard to decode, shrink and upload.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAMklEQVR4nG3CoREAIQADwSsshb1EIpEvkUjEFUgD2Vn8UuNIjTM1rtT4p8adGk9qvKkf/mRhATam/ScAAAAASUVORK5CYII=",
  "base64",
);

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

/** Back to the top with smooth scrolling off — see the note in bilingual-cart. */
async function settle(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  });
}

async function signInToDashboard(page: Page) {
  await page.goto("/dashboard/", { waitUntil: "load" });
  await page.locator("#admin-key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#admin-key")).toHaveCount(0);
  await page.goto("/dashboard/menu", { waitUntil: "load" });
  await expect(page.getByLabel("Search products")).toBeVisible();
}

async function newProduct(page: Page, fields: { name: string; price: string; id?: string; description?: string; photo?: boolean }) {
  await page.getByRole("button", { name: "New product" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New product" })).toBeVisible();
  await dialog.locator("#p-cat").selectOption(CATEGORY.id);
  if (fields.id) await dialog.locator("#p-id").fill(fields.id);
  await dialog.locator("#p-name").fill(fields.name);
  if (fields.description) await dialog.locator("#p-desc").fill(fields.description);
  await dialog.locator("#p-price").fill(fields.price);
  if (fields.photo) {
    await dialog.locator("#p-image").setInputFiles({ name: "cookie.png", mimeType: "image/png", buffer: PHOTO });
    await expect(dialog.getByTestId("product-photo")).toHaveAttribute("src", /^\/api\/images\/[a-f0-9]{32}\.(webp|jpg|png)$/);
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  return dialog;
}

test.afterAll(async ({ baseURL }) => {
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { "x-requested-with": "Holland", origin: baseURL! },
  });
  await api.post("/api/admin/session", { data: { key: ADMIN_KEY } });
  await api.delete(`/api/menu/admin/categories/${CATEGORY.id}?withProducts=1`);
  await api.dispose();
});

test("a product added in the dashboard can be found, bought and printed on a receipt", async ({ page }) => {
  test.setTimeout(150_000);

  // ---------------------------------------------------------- dashboard ----
  await signInToDashboard(page);

  await page.getByRole("button", { name: "New category" }).click();
  await page.locator("#new-category-name").fill(CATEGORY.name);
  await page.locator("#new-category-name-ar").fill(CATEGORY.nameAr);
  await page.locator("#new-category-group").selectOption("desserts");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Created “${CATEGORY.name}”`);

  // No id typed: it is made from the name. This is the exact product that was
  // refused before.
  const dialog = await newProduct(page, { ...PRODUCT, photo: true });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("p[role=status]")).toContainText(`Added “${PRODUCT.name}”`);

  // A second name that makes the same id is numbered, not refused.
  await newProduct(page, { name: TWIN, price: "90" });
  await expect(page.locator("p[role=status]")).toContainText(`Added “${TWIN}”`);

  // A hand-typed id that is taken says so, in words, under the form.
  const refused = await newProduct(page, { name: "Another Cookie", price: "10", id: "pistachio-crunch-cookie" });
  await expect(refused.getByRole("alert")).toHaveText("That product id is taken.");
  await refused.getByRole("button", { name: "Cancel" }).click();

  // --------------------------------------------------------------- API ----
  const menu = await (await page.request.get("/api/menu")).json();
  const category = menu.categories.find((entry: { id: string }) => entry.id === CATEGORY.id);
  expect(category, "the new category is on the public menu").toBeTruthy();
  expect(category.group).toBe("desserts");
  expect(category.items.map((item: { id: string }) => item.id).sort())
    .toEqual(["pistachio-crunch-cookie", "pistachio-crunch-cookie-2"]);
  const product = category.items.find((item: { id: string }) => item.id === "pistachio-crunch-cookie");
  expect(product).toMatchObject({ name: PRODUCT.name, description: PRODUCT.description, price: 85, available: true });
  expect(product.image).toMatch(/^\/api\/images\//);

  // -------------------------------------------------------------- shop ----
  await page.goto("/menu/desserts", { waitUntil: "load" });
  await ready(page);
  await expect(page.getByRole("heading", { name: CATEGORY.name, level: 2 })).toBeVisible();

  const row = page.locator(`#${CATEGORY.id} .menu-item-open`, { hasText: PRODUCT.name }).first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: PRODUCT.name })).toBeVisible();
  await expect(detail).toContainText(PRODUCT.description);
  await expect(detail).toContainText("85.00 EGP");
  await expect(detail.locator("img").first()).toHaveAttribute("src", product.image);
  await detail.locator(".menu-detail-add").click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  await settle(page);
  await page.getByRole("button", { name: "Open cart" }).click();
  const line = page.locator(".cart-line", { hasText: PRODUCT.name });
  await expect(line).toHaveCount(1);
  const thumb = line.locator(".cart-line-media img");
  await expect(thumb).toHaveAttribute("src", product.image);
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator(".ed-summary")).toContainText(PRODUCT.name);
  await page.locator("#firstName").fill("Noha");
  await page.locator("#lastName").fill("Ibrahim");
  await page.locator("#phone").fill("01016521650");
  await page.locator("#area").selectOption("nasr-city");
  await page.locator("#address").fill("27 Mohamed El-Moqrif Street");
  await page.getByRole("button", { name: "Place order" }).click();

  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rcpt-barcode-text")).toHaveText(/^HC-\d+$/);
  // 85 for the cookie plus 40 delivery.
  await expect(page.locator(".rcpt-total-value")).toHaveText("125.00 EGP");
  await expect(page.getByText(PRODUCT.name).first()).toBeVisible();
});
