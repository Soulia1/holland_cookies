import { expect, test, type Page } from "@playwright/test";

/**
 * Pickup, and the printed confirmation.
 *
 * Two things are being guarded here, and both were real defects rather than
 * hypotheticals:
 *
 *  1. A pickup order was still offering "Cash on delivery" — on the checkout
 *     *and* on the printed receipt. There is no driver on a pickup order, so
 *     that sentence names a person who is never going to arrive.
 *  2. The receipt appeared from beneath the whole card rather than out of the
 *     printer's slot. The paper was painted *behind* the card, so the card's
 *     own background covered the opening and the sheet could only ever become
 *     visible below the entire bar. It now sits in front, comes through the
 *     slot, and drapes over the machine's lower lip.
 *
 * The second is a geometry assertion rather than a screenshot comparison: what
 * matters is that the paper's first visible pixel is at the slot, and that at
 * the start of the feed the sheet is tucked up out of sight. That holds however
 * the card is styled, and it does not go stale the way a pixel baseline does.
 */

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

/** Fill the cart and land on the checkout. */
async function toCheckout(page: Page) {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);
  await page.getByRole("button", { name: "Add Vanilla to cart" }).first().click();
  await expect(page.locator(".cart-badge")).toHaveText("1");

  await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  });
  await page.getByRole("button", { name: "Open cart" }).click();
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page.locator(".ed-summary")).toBeVisible();
}

async function fillCustomer(page: Page) {
  await page.locator("#firstName").fill("Noha");
  await page.locator("#lastName").fill("Ibrahim");
  await page.locator("#phone").fill("01016521650");
}

test.describe("pickup", () => {
  test("offers cash on pickup, not cash on delivery", async ({ page }) => {
    await toCheckout(page);

    // Delivery first, so the difference is the thing being asserted.
    await expect(page.locator(".ed-pay-label")).toHaveText("Cash on delivery");
    await expect(page.locator(".ed-pay-sub")).toContainText("driver");

    await page.getByRole("radio", { name: "Pickup" }).click();
    await expect(page.locator(".ed-pay-label")).toHaveText("Cash on pickup");
    await expect(page.locator(".ed-pay-sub")).toContainText("counter");
    // And nothing about a driver survives anywhere on the page.
    await expect(page.locator(".ed-pay-sub")).not.toContainText("driver");
  });

  test("drops the address fields and the delivery fee", async ({ page }) => {
    await toCheckout(page);
    await expect(page.locator("#address")).toBeVisible();
    // 50 for the cookie plus 40 delivery.
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("90.00 EGP");

    await page.getByRole("radio", { name: "Pickup" }).click();
    await expect(page.locator("#address")).toHaveCount(0);
    await expect(page.locator("#area")).toHaveCount(0);
    await expect(page.locator(".ed-srow.total span:last-child")).toHaveText("50.00 EGP");
  });

  test("prints a receipt that says cash on pickup", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    const meta = page.locator(".rcpt-meta");
    await expect(meta).toContainText("Cash on pickup");
    await expect(meta).not.toContainText("Cash on delivery");
    // Priced without delivery, on the receipt as well as in the panel.
    await expect(page.locator(".rcpt-total-value")).toHaveText("50.00 EGP");
  });

  test("prints a receipt that says cash on delivery for a delivery", async ({ page }) => {
    await toCheckout(page);
    await fillCustomer(page);
    await page.locator("#area").selectOption("nasr-city");
    await page.locator("#address").fill("27 Mohamed El-Moqrif Street");
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".rcpt-meta")).toContainText("Cash on delivery");
    await expect(page.locator(".rcpt-total-value")).toHaveText("90.00 EGP");
  });
});

test.describe("the receipt printer", () => {
  test("feeds the paper out of the slot and over the machine's lip", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForSelector(".rcpt-paper", { timeout: 15_000 });

    // Restarted and slowed so the feed can be measured part-way through rather
    // than raced.
    const geometry = await page.evaluate(async () => {
      const paper = document.querySelector<HTMLElement>(".rcpt-paper")!;
      paper.style.animation = "none";
      void paper.offsetWidth;
      paper.style.animation = "rcpt-feed 6000ms linear forwards";
      await new Promise((resolve) => setTimeout(resolve, 900));

      const card = document.querySelector(".rcpt-card")!.getBoundingClientRect();
      const mouth = document.querySelector(".rcpt-mouth")!.getBoundingClientRect();
      const sheet = document.querySelector(".rcpt-sheet")!.getBoundingClientRect();
      const cardStyle = getComputedStyle(document.querySelector(".rcpt-card")!);
      const feedStyle = getComputedStyle(document.querySelector(".rcpt-feed")!);
      return {
        cardBottom: card.bottom,
        cardWidth: card.width,
        mouthTop: mouth.top,
        mouthBottom: mouth.bottom,
        sheetTop: sheet.top,
        sheetBottom: sheet.bottom,
        sheetWidth: sheet.width,
        cardZ: Number(cardStyle.zIndex),
        feedZ: Number(feedStyle.zIndex),
      };
    });

    // The paper is painted IN FRONT of the card. This is the fix: behind it,
    // the card's own background covered the slot, so the sheet could only ever
    // appear below the whole bar and read as a second card sliding out from
    // underneath rather than as paper leaving a port.
    expect(geometry.feedZ).toBeGreaterThan(geometry.cardZ);

    // There is still machine visible below the slot — the lip the paper falls
    // over. Without it the slot is just the card's bottom edge again.
    expect(geometry.cardBottom - geometry.mouthBottom).toBeGreaterThanOrEqual(8);

    // The sheet's leading edge is up inside the machine, hidden by the slot,
    // so the paper has no visible top edge of its own.
    expect(geometry.sheetTop).toBeLessThan(geometry.mouthBottom);
    // ...while its torn edge is already out and below the slot.
    expect(geometry.sheetBottom).toBeGreaterThan(geometry.mouthBottom);

    // Narrower than the machine, so there are cheeks either side of the slot.
    expect(geometry.sheetWidth).toBeLessThan(geometry.cardWidth - 20);
  });

  test("advances in line-sized steps rather than gliding", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForSelector(".rcpt-paper", { timeout: 15_000 });

    const motion = await page.evaluate(async () => {
      const paper = document.querySelector<HTMLElement>(".rcpt-paper")!;
      const sheet = paper.firstElementChild as HTMLElement;
      const lineHeight = parseFloat(getComputedStyle(sheet).lineHeight);

      // Sample the transform every animation frame for a slice of the feed.
      const seen: number[] = [];
      const start = performance.now();
      await new Promise<void>((done) => {
        const tick = () => {
          const m = new DOMMatrixReadOnly(getComputedStyle(paper).transform);
          seen.push(Math.round(m.m42 * 10) / 10);
          if (performance.now() - start < 1200) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });

      const distinct = [...new Set(seen)];
      const gaps = distinct
        .slice(1)
        .map((v, i) => Math.abs(v - distinct[i]))
        .filter((g) => g > 0.5);
      return {
        timing: getComputedStyle(paper).animationTimingFunction,
        frames: seen.length,
        distinct: distinct.length,
        medianGap: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)],
        lineHeight,
      };
    });

    // A stepped timing function, not an ease. This is what the recording shows:
    // differencing its frames gives near-still frames between advances, because
    // a thermal printer drives the platen one line at a time.
    expect(motion.timing).toMatch(/^steps\(/);

    // Far fewer distinct positions than frames — the paper holds, then jumps.
    // A smooth glide would give a new position on essentially every frame.
    expect(motion.frames).toBeGreaterThan(30);
    expect(motion.distinct).toBeLessThan(motion.frames / 3);

    // And each jump is one printed line, which is what makes it read as
    // printing rather than as a panel being nudged along.
    expect(Math.abs(motion.medianGap - motion.lineHeight)).toBeLessThan(2);
  });

  test("says it is printing, then that the order is complete", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    const status = page.locator(".rcpt-status");
    // The status is a live region, so it is announced as well as shown.
    await expect(status).toHaveAttribute("aria-live", "polite");
    // Flips only once the paper has finished feeding, so it can never claim
    // completion over a receipt still visibly moving.
    await expect(status).toContainText("Order complete", { timeout: 15_000 });
    await expect(page.locator(".rcpt-status-dot.is-done")).toBeVisible();
  });

  test("prints the order the customer actually placed", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    const reference = await page.locator(".rcpt-barcode-text").innerText();
    expect(reference).toMatch(/^HC-\d+$/);

    // The reference under the barcode and the one on the meta line are the
    // same order, and the line item is the cookie that was added.
    await expect(page.locator(".rcpt-meta")).toContainText(reference);
    await expect(page.locator(".rcpt-lines").first()).toContainText("Vanilla");
  });

  test("offers what to do next only once the receipt has printed", async ({ page }) => {
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-actions.is-in")).toBeVisible({ timeout: 15_000 });
    // And that link really goes to this order.
    const reference = await page.locator(".rcpt-barcode-text").innerText();
    await expect(page.getByRole("link", { name: "Track this order" }))
      .toHaveAttribute("href", `/track?ref=${encodeURIComponent(reference)}`);
  });
});

test.describe("the receipt under reduced motion", () => {
  test("is simply there, already complete", async ({ page }) => {
    // Set on the page rather than through `test.use`, which this Playwright
    // build does not type as a valid fixture here.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await toCheckout(page);
    await page.getByRole("radio", { name: "Pickup" }).click();
    await fillCustomer(page);
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
    // Nobody should sit through two seconds of paper feed to read the reference
    // number they came for.
    await expect(page.locator(".rcpt-status")).toContainText("Order complete");
    const transform = await page.locator(".rcpt-paper").evaluate(
      (el) => getComputedStyle(el).transform,
    );
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
  });
});
