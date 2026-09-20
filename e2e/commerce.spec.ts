import { expect, test, type Page } from "@playwright/test";

/**
 * The order pipeline, end to end, through a real browser against the real
 * server and a real database.
 *
 * The unit suite already proves the server prices an order from the catalogue
 * and ignores whatever the client claims. What it cannot prove is that the
 * *page* wired to that server does the right thing — that the cart survives the
 * trip to checkout, that a validation failure lands under the field it belongs
 * to, that a customer can find their order again afterwards. That is this file.
 */

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

/** Add a product to the cart from the menu page and land on checkout. */
async function startCheckout(page: Page, product = "Vanilla, Lotus filling") {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);
  const add = page.getByRole("button", { name: `Add ${product} to cart` }).first();
  // Centred first: scrolled only "into view" on a phone, the row lands under the
  // sticky category bar, which moves as the header condenses and takes the tap.
  await add.evaluate((el) => el.scrollIntoView({ block: "center" }));
  // Tapped again if nothing landed. On WebKit a click can arrive while the row
  // is re-rendering and be swallowed, and the next line then waits for a badge
  // that will never appear — a person taps again, and the count is checked
  // first so a click that did land is never doubled.
  const badge = page.locator(".cart-badge");
  await expect(async () => {
    if (await badge.count() === 0) await add.click();
    await expect(badge).toHaveText("1", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await settle(page);
  await page.getByRole("button", { name: "Open cart" }).click();
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  // The page prices the cart against the live catalogue before it draws a
  // figure, so wait for that rather than for the URL.
  await expect(page.locator(".ed-srow.total")).toBeVisible();
}

async function fillCustomer(page: Page, overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    firstName: "Noha",
    lastName: "Ibrahim",
    phone: "01016521650",
    email: "noha@example.com",
    address: "27 Mohamed El-Moqrif Street",
    ...overrides,
  };
  for (const [field, value] of Object.entries(values)) {
    if (value === "") continue;
    await page.locator(`#${field}`).fill(value);
  }
  if (overrides.area !== "") await page.locator("#area").selectOption("nasr-city");
}

test.describe("placing an order", () => {
  test("cart survives the trip to checkout and prices from the catalogue", async ({ page }) => {
    await startCheckout(page);

    await expect(page.locator(".ed-sum-info span").first()).toHaveText("Vanilla, Lotus filling");
    await expect(page.locator(".ed-sum-price").first()).toHaveText("60.00 EGP");
    // No photo was uploaded for it in the dashboard, so the summary shows the
    // menu's own photo — not the placeholder cookie.
    const thumb = page.locator(".ed-sum-thumb img").first();
    await expect(thumb).toHaveAttribute("src", /cup-caramel\.webp$/);
    expect(await thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // 60 subtotal + 40 delivery, below the 600 free-delivery threshold.
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("100.00 EGP");
  });

  test("delivery is waived over the threshold", async ({ page }) => {
    // Straight to the cookie scoops, which is where the 450 EGP items are —
    // the bare root lands on the cookies group anyway.
    await page.goto("/menu/cookies#cookie-scoops", { waitUntil: "load" });
    await ready(page);
    // 450 EGP each; two clears the 600 threshold.
    const add = page.getByRole("button", { name: "Add Vanilla to cart" }).first();
    // Centred, and the badge counted between the two taps. Clicking twice in
    // the same frame relies on the button not moving between the hit test and
    // the click, and on desktop WebKit it does move — the face swaps to a tick
    // — so CI recorded one scoop and a 490 total. A person's second tap comes
    // after they have seen the first one land; this waits for the same thing.
    await add.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await add.click();
    await expect(page.locator(".cart-badge")).toHaveText("1");
    await add.click();
    await expect(page.locator(".cart-badge")).toHaveText("2");
    await settle(page);
    await page.getByRole("button", { name: "Open cart" }).click();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("900.00 EGP");
  });

  test("switching to pickup removes the delivery fee and the address fields", async ({ page }) => {
    await startCheckout(page);
    await expect(page.locator("#address")).toBeVisible();

    await page.getByRole("radio", { name: "Pickup" }).click();
    await expect(page.locator("#address")).toHaveCount(0);
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("60.00 EGP");
  });

  test("places the order and shows a reference", async ({ page }) => {
    await startCheckout(page);
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    const reference = await page.locator(".rcpt-barcode-text").innerText();
    expect(reference).toMatch(/^HC-\d+$/);
    await expect(page.locator(".rcpt-total-value")).toHaveText("100.00 EGP");

    // The cart is emptied only once the order exists.
    await expect(page.locator(".cart-badge")).toHaveCount(0);
  });

  test("a validation failure lands under the field it belongs to", async ({ page }) => {
    await startCheckout(page);
    // Everything except the area, which the server requires for a delivery.
    await fillCustomer(page, { area: "" });
    await page.getByRole("button", { name: "Place order" }).click();

    const field = page.locator(".ed-field.has-error");
    await expect(field).toHaveCount(1);
    await expect(field.locator(".ed-error")).toBeVisible();
    // Wired for a screen reader, not only painted red.
    await expect(page.locator("#area")).toHaveAttribute("aria-invalid", "true");
    // And the customer still has their cart.
    await expect(page.locator(".ed-sum-info span").first()).toHaveText("Vanilla, Lotus filling");
  });

  test("a promo code discounts the total", async ({ page }) => {
    await startCheckout(page);
    await page.locator("#promo").fill("E2E10");
    await page.getByRole("button", { name: "Apply", exact: true }).click();

    await expect(page.locator(".ed-promo-msg.ok")).toContainText("E2E10");
    // 60 less 10% = 54, plus 40 delivery.
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("94.00 EGP");
  });

  test("rejects a promo code that does not exist", async ({ page }) => {
    await startCheckout(page);
    await page.locator("#promo").fill("NOPE");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator(".ed-promo-msg.bad")).toBeVisible();
  });
});

test.describe("finding an order again", () => {
  test("tracking needs the phone number as well as the reference", async ({ page }) => {
    await startCheckout(page);
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    const reference = await page.locator(".rcpt-barcode-text").innerText();

    await page.goto("/track", { waitUntil: "load" });
    await ready(page);

    // The right reference with the wrong number must reveal nothing — the whole
    // point of the second factor, since references are sequential.
    await page.locator("#track-ref").fill(reference);
    await page.locator("#track-phone").fill("01111111111");
    await page.getByRole("button", { name: "Find my order" }).click();
    await expect(page.locator(".ed-alert")).toBeVisible();
    await expect(page.locator(".trk-steps")).toHaveCount(0);

    await page.locator("#track-phone").fill("01016521650");
    await page.getByRole("button", { name: "Find my order" }).click();
    await expect(page.locator(".trk-ref")).toHaveText(reference);
    // One step reached — the order was only just placed.
    await expect(page.locator(".trk-step.is-done")).toHaveCount(1);
  });
});

test.describe("in Arabic", () => {
  test("the whole order flow works right-to-left", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await page.getByRole("button", { name: "AR", exact: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Product names fall back to English until the sheets are transcribed, so
    // the accessible name is the Arabic frame around the English name — which
    // is exactly what `localized()` is specified to do.
    //
    // Named exactly rather than by /Vanilla/, and awaited rather than clicked
    // immediately. Both matter, and the loose version had been silently broken:
    // twenty products in the menu contain "Vanilla", so the regex was only ever
    // right by DOM accident, and clicking in the same tick as the language
    // switch raced the re-render that relabels every button — the click landed
    // on a node React was in the middle of replacing and the cart stayed empty.
    // Asserting the Arabic label first is what proves the re-render finished.
    const addVanilla = page.getByRole("button", { name: "ضيف Vanilla, Lotus filling للسلة" }).first();
    await expect(addVanilla).toBeVisible();
    await addVanilla.click();
    await expect(page.locator(".cart-badge")).toHaveText("1");

    await settle(page);
    await page.getByRole("button", { name: "افتح السلة" }).click();
    await page.getByRole("button", { name: "إتمام الطلب" }).click();
    await expect(page).toHaveURL(/\/checkout$/);

    // The checkout is Arabic and still right-to-left after the navigation.
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    // The eyebrow carries "Checkout"; the title is the section, "Your details".
    await expect(page.locator(".ed-tag").first()).toHaveText("إتمام الطلب");
    await expect(page.locator(".ed-title")).toHaveText("بياناتك");

    await page.locator("#firstName").fill("نهى");
    await page.locator("#lastName").fill("إبراهيم");
    await page.locator("#phone").fill("01016521650");
    await page.locator("#area").selectOption("nasr-city");
    await page.locator("#address").fill("٢٧ ش محمد المقرف");
    await page.getByRole("button", { name: "أكد الطلب" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    // The reference stays Latin and left-to-right inside the Arabic page: it is
    // dialled and typed, not read as prose.
    await expect(page.locator(".rcpt-barcode-text")).toHaveAttribute("dir", "ltr");
    await expect(page.locator(".rcpt-barcode-text")).toHaveText(/^HC-\d+$/);
  });

  test("does not scroll horizontally at checkout", async ({ page }) => {
    await startCheckout(page);
    await page.getByRole("button", { name: "AR", exact: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, "the Arabic checkout scrolls horizontally").toBe(false);
  });
});
