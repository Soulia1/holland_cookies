import { expect, test, type Page } from "@playwright/test";

// Interaction coverage: navigation, cards, the detail dialog, and the things
// that only break on a phone.

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

/** Wait for the boot splash to have retired, so tests act on a settled page. */
async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

test("the homepage loads with every section and no console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  await expect(page.locator("h1")).toContainText("Your Cookie Party");
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#craft")).toBeVisible();
  await expect(page.locator("#visit")).toBeVisible();
  await expect(page.locator("footer")).toBeVisible();

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("the hero photograph is actually painted, not just present", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);
  // naturalWidth is zero for an <img> that failed or has not decoded. The
  // splash is supposed to have waited for exactly this.
  const painted = await page.locator("#top img").first().evaluate(
    (img) => (img as HTMLImageElement).naturalWidth,
  );
  expect(painted).toBeGreaterThan(0);
});

test("all three menu cards reveal on scroll", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  const cards = page.locator(".pan-card");
  await expect(cards).toHaveCount(3);

  // Each card is scrolled past in turn. On a phone the grid collapses to one
  // column, so the three cards are spread over more than a screen — bringing
  // only the section heading into view leaves the lower two below the fold,
  // correctly unrevealed. Walking them is what makes this test mean the same
  // thing at every viewport.
  for (let i = 0; i < 3; i += 1) {
    await cards.nth(i).evaluate((el) => {
      const y = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: y - 200, behavior: "instant" as ScrollBehavior });
    });
    await expect(cards.nth(i)).toBeVisible();
  }

  // A reveal that never fires leaves the element at opacity 0 forever — the
  // failure mode where content is hidden behind an effect that did not run.
  //
  // Polled rather than sampled once. The reveal is a 700ms transition behind a
  // stagger delay, so reading it the instant the section scrolls into view
  // catches it mid-flight and says nothing about whether it completes.
  await expect
    .poll(
      async () =>
        page.locator(".pan-card").evaluateAll((nodes) =>
          Math.min(
            ...nodes.map((n) =>
              Number(getComputedStyle(n.parentElement as Element).opacity),
            ),
          ),
        ),
      { timeout: 5000, message: "menu cards never finished revealing" },
    )
    .toBeGreaterThan(0.9);
});

test("a card the viewport jumps clean past still reveals", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // One instantaneous move, from the top of the page to the last card. That
  // carries the FIRST card from below the viewport to above it inside a single
  // frame, so it never intersects.
  //
  // An IntersectionObserver reports where its targets are when it delivers, not
  // every position they passed through, so a target that is below on one
  // delivery and above on the next crosses no threshold and gets no callback at
  // all. Before reveal.tsx swept for this, that card stayed at opacity 0 for the
  // life of the page — content permanently hidden behind an effect that never
  // ran. It is the same failure the header hit with a 1px sentinel.
  await page.locator(".pan-card").last().evaluate((el) => {
    const y = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: y - 200, behavior: "instant" as ScrollBehavior });
  });

  await expect
    .poll(
      async () =>
        page.locator(".pan-card").evaluateAll((nodes) =>
          Math.min(
            ...nodes.map((n) =>
              Number(getComputedStyle(n.parentElement as Element).opacity),
            ),
          ),
        ),
      { timeout: 5000, message: "a jumped-past card never revealed" },
    )
    .toBeGreaterThan(0.9);
});

test("the detail dialog opens, traps focus, closes on Escape, and restores focus", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);
  await page.locator("#menu").scrollIntoViewIfNeeded();

  const firstCard = page.locator(".pan-card").first();
  await firstCard.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Classic Chocolate Chip Pan");

  // Focus must be inside the dialog, not left on the page behind it.
  const focusInside = await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    return !!d && d.contains(document.activeElement);
  });
  expect(focusInside, "focus was not moved into the dialog").toBe(true);

  // The page behind must not scroll while the dialog is open.
  await expect(page.locator("body")).toHaveClass(/is-locked/);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/is-locked/);

  // Radix returns focus to the control that opened it. Without that, a keyboard
  // user is dumped back at the top of the document.
  const returned = await firstCard.evaluate((el) => el === document.activeElement);
  expect(returned, "focus was not returned to the card that opened the dialog").toBe(true);
});

test("the dialog closes on a backdrop click", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);
  await page.locator("#menu").scrollIntoViewIfNeeded();
  await page.locator(".pan-card").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Top-left corner is backdrop in both the centred and the bottom-sheet layout.
  await page.mouse.click(6, 6);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the header turns solid once the menu reaches it, and not before", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  const header = page.locator("header");
  const bg = () => header.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Over the hero the bar is see-through: there is nothing for an opaque bar to
  // separate the nav from, and a solid slab would just cut the top off the
  // photograph.
  const overHero = await bg();
  expect(overHero).toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);

  // Scrolled instantly, on purpose. `scroll-behavior: smooth` is a real part of
  // the design, but its duration scales with the distance travelled — on a
  // phone the document is tall enough that animating down to #craft takes
  // several seconds. Waiting that out would make this a test of the scroll
  // animation rather than of the header's state, and a slow one at that.
  await page.evaluate(() => {
    // `behavior: "instant"` is not honoured by every WebKit build — where it is
    // not, the call silently inherits the stylesheet's `scroll-behavior: smooth`
    // and animates. Clearing the property outright is the only way to be sure
    // the jump is immediate.
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const craft = document.getElementById("craft");
    if (craft) {
      window.scrollTo(0, craft.getBoundingClientRect().top + window.scrollY);
    }
    root.style.scrollBehavior = previous;
  });

  // Still polled: the header's own background transition runs after the scroll
  // lands, so a single read can catch it part-way.
  await expect
    .poll(bg, { timeout: 5000, message: "the header never took its background" })
    .not.toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);
});

test("anchor navigation reaches each section", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  for (const id of ["menu", "craft", "visit"]) {
    await page.evaluate((target) => {
      document.getElementById(target)?.scrollIntoView();
    }, id);
    await page.waitForTimeout(250);
    await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 0.05 });
  }
});

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "touch layout only");

  test("the mobile menu opens, navigates, and closes", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);

    const toggle = page.getByRole("button", { name: /open menu/i });
    await expect(toggle).toBeVisible();

    const panel = page.locator("#mobile-menu");
    // Closed: collapsed to zero height, and its links are out of the tab order.
    expect(await panel.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(4);

    await toggle.click();
    await page.waitForTimeout(450);
    expect(
      await panel.evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThan(40);

    await panel.getByRole("link", { name: "Menu" }).click();
    await page.waitForTimeout(450);
    // Tapping a link closes the panel rather than leaving it over the section
    // the visitor just asked to see.
    expect(await panel.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(4);
  });

  test("the dialog is usable and does not overflow the viewport", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await page.locator("#menu").scrollIntoViewIfNeeded();
    await page.locator(".pan-card").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "dialog has no box").not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    // A bottom sheet must reach the bottom edge, not float above it.
    expect(box!.y + box!.height).toBeGreaterThan(viewport!.height - 4);

    // The document behind must not have grown a horizontal scrollbar.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, "the page scrolls horizontally").toBe(false);
  });

  test("no horizontal overflow anywhere down the page", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    for (const id of ["menu", "craft", "visit"]) {
      await page.evaluate((t) => document.getElementById(t)?.scrollIntoView(), id);
      await page.waitForTimeout(200);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `horizontal overflow at #${id}`).toBe(false);
    }
  });
});
