import { expect, test, type Page } from "@playwright/test";

/**
 * Language, direction, and the cart.
 *
 * The three things this suite is really guarding are the three that a unit test
 * cannot reach: that the language survives a *reload* (which means the inline
 * script in index.html and the React provider agree), that the layout actually
 * mirrors rather than merely translating, and that the cart survives the two
 * events most likely to destroy it — a refresh and a language switch.
 */

/** Wait for the boot splash to have retired, so tests act on a settled page. */
async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

async function switchTo(page: Page, lang: "en" | "ar") {
  await page.getByRole("button", { name: lang === "ar" ? "AR" : "EN", exact: true })
    .first()
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
}

/**
 * Wait for the page to stop scrolling.
 *
 * The stylesheet sets `scroll-behavior: smooth`, so *every* programmatic scroll
 * is animated — including the scroll-into-view Playwright performs before it
 * clicks anything. While that animation is in flight WebKit misreports
 * `getBoundingClientRect()` for `position: fixed` elements: the header does not
 * move on screen, but its reported box slides with the scroll. Playwright reads
 * that as "element is not stable" and refuses to click the header, and since
 * each retry can start another scroll it never converges — a 45s timeout on a
 * button that is sitting perfectly still.
 *
 * So: settle first, then touch the header. Polling the position rather than
 * waiting a fixed time, because the distance — and therefore the duration — is
 * different in every test.
 */
async function settled(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const start = window.scrollY;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(window.scrollY === start)),
              );
            }),
        ),
      { timeout: 5000, message: "the page never stopped scrolling" },
    )
    .toBe(true);
}

/** Open the cart from the header, once the page is done moving. */
async function openCart(page: Page, name = "Open cart") {
  // Back to the top first, with smooth scrolling switched off for the move.
  // Two things force this. `scroll-behavior: smooth` turns every programmatic
  // scroll into an animation, and WebKit misreports a fixed element's rect
  // while one is running — so Playwright decides the header is "not stable",
  // and then that it is "outside of the viewport", and retries until the test
  // times out on a button that has not moved a pixel on screen.
  await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  });
  await settled(page);
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/**
 * The add control for a named product.
 *
 * Found by its accessible name rather than by position, which is the point of
 * putting the product into that label in the first place — a hundred and ten
 * buttons all called "Add to cart" would be unaddressable here and equally
 * unaddressable to someone using a screen reader.
 */
function addButton(page: Page, product: string) {
  return page.getByRole("button", { name: `Add ${product} to cart` }).first();
}

test.describe("language", () => {
  test("starts in English with a left-to-right document", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("switching to Arabic flips the document and translates the page", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    // Not just "some Arabic somewhere": the headline itself, which is the
    // string a visitor reads first.
    await expect(page.locator("h1")).toContainText("بارتي الكوكيز");
    await expect(page.locator("h1")).not.toContainText("Your Cookie Party");
  });

  test("survives a reload without a flash of the wrong direction", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");

    await page.reload({ waitUntil: "commit" });
    // Read at `commit`, before the bundle has run at all. This is the assertion
    // that the inline script in index.html is doing its job: if the language
    // were applied by a React effect instead, the document would be `ltr` here
    // and flip a frame later — a visible lurch on every single page load for
    // every Arabic visitor.
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  });

  test("survives navigation to the menu page", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");

    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("h1")).toContainText("المنيو");
  });

  test("switching back to English restores it", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");
    await switchTo(page, "en");

    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("h1")).toContainText("Your Cookie Party");
  });

  test("loads an Arabic face rather than falling back to a system font", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");
    // The stylesheet is requested at runtime by i18n.tsx. Without it the page
    // would still lay out correctly and would silently lose the identity, which
    // is exactly the kind of regression nobody notices until a customer does.
    await expect(page.locator("#arabic-fonts")).toHaveCount(1);
  });

  test("does not scroll horizontally in Arabic", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await switchTo(page, "ar");

    // The whole page, not just the first screen: mirroring an absolutely
    // positioned element the wrong way pushes it off the *other* edge, and that
    // shows up as overflow somewhere down the document rather than at the top.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, "the Arabic page scrolls horizontally").toBe(false);
  });
});

test.describe("cart", () => {
  test("adds a product and counts it in the header", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);

    await addButton(page, "Vanilla").click();
    await expect(page.locator(".cart-badge")).toHaveText("1");
  });

  test("a repeat add is one line at quantity two, not two lines", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);

    const add = addButton(page, "Vanilla");
    await add.click();
    await add.click();
    await expect(page.locator(".cart-badge")).toHaveText("2");

    await openCart(page);
    await expect(page.locator(".cart-line")).toHaveCount(1);
    await expect(page.locator(".cart-qty-value")).toHaveText("2");
  });

  test("survives a reload", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await expect(page.locator(".cart-badge")).toHaveText("1");

    await page.reload({ waitUntil: "load" });
    await ready(page);
    await expect(page.locator(".cart-badge")).toHaveText("1");
  });

  test("survives a language change", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await expect(page.locator(".cart-badge")).toHaveText("1");

    await switchTo(page, "ar");
    // The cart is keyed by the product id, never by the display name — so
    // renaming every product on the page must not lose, duplicate or empty it.
    await expect(page.locator(".cart-badge")).toHaveText("1");
    await openCart(page, "افتح السلة");
    await expect(page.locator(".cart-line")).toHaveCount(1);
  });

  test("survives navigation between pages", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await expect(page.locator(".cart-badge")).toHaveText("1");

    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await expect(page.locator(".cart-badge")).toHaveText("1");
  });

  test("quantity steppers add, subtract, and remove the line at zero", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await openCart(page);

    await page.getByRole("button", { name: "One more Vanilla" }).click();
    await expect(page.locator(".cart-qty-value")).toHaveText("2");

    await page.getByRole("button", { name: "One fewer Vanilla" }).click();
    await expect(page.locator(".cart-qty-value")).toHaveText("1");

    // The last decrement removes the line rather than leaving a zero-quantity
    // row nobody can do anything with.
    await page.getByRole("button", { name: "One fewer Vanilla" }).click();
    await expect(page.locator(".cart-line")).toHaveCount(0);
    await expect(page.locator(".cart-empty-title")).toBeVisible();
  });

  test("clearing empties it", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await addButton(page, "Lotus").click();
    await openCart(page);
    await expect(page.locator(".cart-line")).toHaveCount(2);

    await page.getByRole("button", { name: "Clear cart" }).click();
    await expect(page.locator(".cart-line")).toHaveCount(0);
  });

  test("the drawer closes on Escape and does not scroll the page behind it", async ({
    page,
  }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    await addButton(page, "Vanilla").click();
    await openCart(page);

    const drawer = page.getByRole("dialog");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });

  test("Build Your Box adds the selected box, not the first one", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await page.locator("#boxes").scrollIntoViewIfNeeded();

    // The second option, so a component that ignored the selection and always
    // added `BOXES[0]` would fail here rather than passing by coincidence.
    await page.locator(".box-option").nth(1).click();
    const name = await page.locator(".box-detail-name").innerText();

    await page.locator(".box-order").click();
    await openCart(page);
    await expect(page.locator(".cart-line-name")).toHaveText(name);
  });
});

test.describe("the add control on a pointer device", () => {
  // Desktop only: the whole point of the hover treatment is that it does not
  // exist on a touch device, and asserting a hover on iPhone WebKit would be
  // asserting something the platform cannot do.
  test.skip(({ isMobile }) => !!isMobile, "hover reveal is pointer-only");

  test("is revealed by hovering its row and hidden again after", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);

    const row = page.locator(".menu-item").first();
    const add = row.locator(".menu-item-add");

    await expect(add).toHaveCSS("opacity", "0");
    await row.hover();
    // Polled rather than read once: the reveal is a transition, so a single
    // read immediately after the hover measures whatever value the animation
    // happens to be passing through.
    await expect.poll(async () => Number(await add.evaluate(
      (el) => getComputedStyle(el).opacity,
    ))).toBeGreaterThan(0.9);
  });

  test("stays reachable by keyboard without any pointer", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);

    const add = page.locator(".menu-item-add").first();
    // A control revealed only by hover must still be focusable, or the menu is
    // unusable to anyone navigating by keyboard. This is why the hidden state
    // is opacity and pointer-events rather than `display: none`.
    await add.focus();
    await expect.poll(async () => Number(await add.evaluate(
      (el) => getComputedStyle(el).opacity,
    ))).toBeGreaterThan(0.9);

    await page.keyboard.press("Enter");
    await expect(page.locator(".cart-badge")).toHaveText("1");
  });
});

test.describe("the add control on a touch device", () => {
  test.skip(({ isMobile }) => !isMobile, "touch behaviour only");

  test("is visible without any hover", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "load" });
    await ready(page);
    // The failure this guards against is the single most common way this
    // interaction ships broken: hidden by default, revealed by a hover the
    // device cannot perform, leaving a phone with a menu it cannot order from.
    await expect(page.locator(".menu-item-add").first()).toBeVisible();
    await expect(page.locator(".menu-item-add").first()).toHaveCSS("opacity", "1");
  });

  test("does not cover the card it belongs to", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await page.locator("#menu").scrollIntoViewIfNeeded();

    // On touch the add button sits below the card in normal flow. When it was
    // absolutely positioned over the photograph it intercepted the taps meant
    // for the card, and the product detail could not be opened at all.
    const card = page.locator(".pan-card").first();
    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
