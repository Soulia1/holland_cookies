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

/**
 * The second story in this file: a product whose options are priced.
 *
 * Filed under the Special Edition page, so the same walk also proves that the
 * newest menu group is a real storefront page a dashboard category can be put
 * on — not only that its id is in a list.
 */
const OPTIONED_CATEGORY = {
  id: "special-drops-e2e",
  name: "Special Drops E2E",
  nameAr: "إصدارات",
  group: "special-edition",
};
const OPTIONED = { name: "Dubai Chocolate Slab", price: "180" };
const OPTIONS = [
  { name: "Regular", nameAr: "عادي", extra: "" },
  { name: "Large", nameAr: "كبير", extra: "60" },
];

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
  await api.delete(`/api/menu/admin/categories/${OPTIONED_CATEGORY.id}?withProducts=1`);
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

/*
 * An option that costs extra, from the dashboard to the receipt.
 *
 * The number this is really about is the one on the receipt. Six places have to
 * agree on it — the editor, the stored product, the public menu, the item
 * dialog, the cart snapshot and the server's own arithmetic — and if the last
 * of them disagrees with the fifth, checkout does not show a wrong price, it
 * fails every order with PRICE_CHANGED. So the walk ends at a paid total rather
 * than at a rendered one.
 */
test("an option that costs extra is priced the same way from the editor to the receipt", async ({ page }) => {
  test.setTimeout(150_000);

  // ---------------------------------------------------------- dashboard ----
  await signInToDashboard(page);

  await page.getByRole("button", { name: "New category" }).click();
  await page.locator("#new-category-name").fill(OPTIONED_CATEGORY.name);
  await page.locator("#new-category-name-ar").fill(OPTIONED_CATEGORY.nameAr);
  // The group added with this feature: a page a dashboard category can be filed
  // under, which is only true if the storefront renders it.
  await page.locator("#new-category-group").selectOption(OPTIONED_CATEGORY.group);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("p[role=status]")).toContainText(`Created “${OPTIONED_CATEGORY.name}”`);

  await page.getByRole("button", { name: "New product" }).click();
  const form = page.getByRole("dialog");
  await form.locator("#p-cat").selectOption(OPTIONED_CATEGORY.id);
  await form.locator("#p-name").fill(OPTIONED.name);
  await form.locator("#p-price").fill(OPTIONED.price);

  for (const [index, option] of OPTIONS.entries()) {
    await form.getByRole("button", { name: "Add option" }).click();
    await form.getByLabel(`Option ${index + 1} (English)`).fill(option.name);
    await form.getByLabel(`Option ${index + 1} (Arabic)`).fill(option.nameAr);
    if (option.extra) await form.getByLabel(`Option ${index + 1} extra price (EGP)`).fill(option.extra);
  }
  // The editor does the addition for the admin, so a size is never put on the
  // menu at a price nobody worked out.
  await expect(form.locator('[aria-label="Option 1 sells for"]')).toHaveText("= 180.00 EGP");
  await expect(form.locator('[aria-label="Option 2 sells for"]')).toHaveText("= 240.00 EGP");

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator("p[role=status]")).toContainText(`Added “${OPTIONED.name}”`);

  // --------------------------------------------------------------- API ----
  const menu = await (await page.request.get("/api/menu")).json();
  const category = menu.categories.find((entry: { id: string }) => entry.id === OPTIONED_CATEGORY.id);
  expect(category, "the new category is on the public menu").toBeTruthy();
  expect(category.group).toBe(OPTIONED_CATEGORY.group);
  const product = category.items[0];
  expect(product.choices).toEqual([
    { name: "Regular", nameAr: "عادي", priceDelta: 0 },
    { name: "Large", nameAr: "كبير", priceDelta: 60 },
  ]);

  // -------------------------------------------------------------- shop ----
  await page.goto(`/menu/${OPTIONED_CATEGORY.group}`, { waitUntil: "load" });
  await ready(page);
  await expect(page.getByRole("heading", { name: OPTIONED_CATEGORY.name, level: 2 })).toBeVisible();

  const row = page.locator(`#${OPTIONED_CATEGORY.id} .menu-item-open`, { hasText: OPTIONED.name }).first();
  // The row quotes the cheapest way to buy it, not a price with no option.
  await expect(row.locator(".menu-item-price")).toHaveText("from 180.00 EGP");
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.click();

  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: OPTIONED.name })).toBeVisible();
  // Nothing is added until an option is picked, and the price follows the pick.
  await expect(detail.locator(".menu-detail-add")).toBeDisabled();
  await expect(detail.getByRole("radio", { name: "Large" })).toContainText("+60.00 EGP");

  await detail.getByRole("radio", { name: "Regular" }).click();
  await expect(detail.getByText("180.00 EGP").first()).toBeVisible();
  await detail.getByRole("radio", { name: "Large" }).click();
  await expect(detail.getByText("240.00 EGP").first()).toBeVisible();
  await detail.locator(".menu-detail-add").click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // -------------------------------------------------------------- cart ----
  await settle(page);
  await page.getByRole("button", { name: "Open cart" }).click();
  const line = page.locator(".cart-line", { hasText: OPTIONED.name });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Large");
  await expect(line).toContainText("240.00 EGP");

  // ---------------------------------------------------------- checkout ----
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator(".ed-summary")).toContainText("240.00 EGP");

  // The area select carries both governorates, each as its own group.
  const area = page.locator("#area");
  await expect(area.locator("optgroup")).toHaveCount(2);
  expect(await area.locator("optgroup").evaluateAll(
    (groups) => groups.map((group) => (group as HTMLOptGroupElement).label),
  )).toEqual(["Cairo", "Giza"]);
  await expect(area.locator('optgroup[label="Giza"] option[value="haram"]')).toHaveCount(1);

  await page.locator("#firstName").fill("Noha");
  await page.locator("#lastName").fill("Ibrahim");
  await page.locator("#phone").fill("01016521650");
  await area.selectOption("haram");
  await page.locator("#address").fill("12 Haram Street");
  await page.getByRole("button", { name: "Place order" }).click();

  // ------------------------------------------------------------ receipt ----
  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  // 180 for the slab, 60 for the large option, 40 delivery.
  await expect(page.locator(".rcpt-total-value")).toHaveText("280.00 EGP");
  await expect(page.getByText("Large").first()).toBeVisible();
});

/*
 * The Special Edition page as the shop is seeded with it.
 *
 * Separate from the walk above because it is asserting a different thing: that
 * the two rows the menu file ships actually arrive in the database and are
 * orderable, not that the dashboard can write more.
 */
test("the seeded Special Edition page sells its two items with their sizes", async ({ page }) => {
  await page.goto("/menu/special-edition", { waitUntil: "load" });
  await ready(page);

  await expect(page.locator("h1")).toHaveText("Special Edition");
  const section = page.locator("#special-edition-cookies");
  await expect(section.locator(".menu-item")).toHaveCount(2);
  await expect(section.locator(".menu-item-name")).toContainText([
    "Dubai Chocolate Cookie",
    "Pistachio Kunafa Cookie Pan",
  ]);
  await expect(section.locator(".menu-item-price").first()).toHaveText("from 180.00 EGP");

  const row = section.locator(".menu-item-open", { hasText: "Pistachio Kunafa Cookie Pan" }).first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("radio", { name: "Family tray" })).toContainText("+120.00 EGP");
  await detail.getByRole("radio", { name: "Family tray" }).click();
  await expect(detail.getByText("340.00 EGP").first()).toBeVisible();
});

/*
 * The made-to-order promise, from the page to the checkout.
 *
 * Its whole job is to reach the customer *before* they pay, so this walks the
 * four places it has to appear and the one place it must not: an everyday item
 * in the same cart, which the shop bakes today and which a blanket notice would
 * wrongly hold up for two days.
 */
test("a made-to-order page says so on the page, in the item, in the cart and at checkout", async ({ page }) => {
  await page.goto("/menu/special-edition", { waitUntil: "load" });
  await ready(page);

  // 1. Under the page title, where it is read before anything is chosen.
  const notice = page.locator(".menu-lead");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Made to order");
  await expect(notice).toContainText("Order 2 working days ahead");

  // 2. In the item, where the decision is actually made.
  const row = page.locator(".menu-item-open", { hasText: "Dubai Chocolate Cookie" }).first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.click();
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".menu-detail-lead")).toHaveText("Made to order — allow 2 working days.");
  await detail.getByRole("radio").first().click();
  await detail.locator(".menu-detail-add").click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.keyboard.press("Escape");

  // An everyday cookie in the same basket, which must not be held up by it.
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  const everyday = page.getByRole("button", { name: "Add Vanilla, Lotus filling to cart" }).first();
  await everyday.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(async () => {
    if (await page.locator(".cart-badge").textContent() === "1") await everyday.click();
    await expect(page.locator(".cart-badge")).toHaveText("2", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });

  // 3. In the cart: short on the line it belongs to, named over the total, and
  //    nothing at all on the line the shop bakes today.
  await settle(page);
  await page.getByRole("button", { name: "Open cart" }).click();
  const made = page.locator(".cart-line", { hasText: "Dubai Chocolate Cookie" });
  const today = page.locator(".cart-line", { hasText: "Vanilla, Lotus filling" });
  await expect(made.locator(".cart-line-lead")).toHaveText("Takes 2 working days");
  await expect(today.locator(".cart-line-lead")).toHaveCount(0);
  await expect(page.locator(".cart-lead")).toHaveText(
    "Dubai Chocolate Cookie will take 2 working days until delivery",
  );

  // 4. At checkout, the last screen before paying.
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator(".ed-lead")).toHaveText(
    "Dubai Chocolate Cookie will take 2 working days until delivery",
  );
  await expect(page.locator(".ed-sum-item", { hasText: "Dubai Chocolate Cookie" }).locator(".ed-sum-lead"))
    .toHaveText("Takes 2 working days");
  await expect(page.locator(".ed-sum-item", { hasText: "Vanilla, Lotus filling" }).locator(".ed-sum-lead"))
    .toHaveCount(0);
});

test("an everyday page carries no made-to-order notice", async ({ page }) => {
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".menu-lead")).toHaveCount(0);
});
