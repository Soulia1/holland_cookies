import { expect, test, type Page } from "@playwright/test";
import { ITEM_COUNT, MENU } from "../src/data/menu";

// The dedicated menu page: routing, the category bar, active tracking, the
// merge with the site header, and the decorative word.

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

const activePill = (page: Page) =>
  page.evaluate(() => document.querySelector(".cat-pill.is-active")?.textContent ?? null);

/**
 * Scroll so a section's own top sits `offset` below the viewport top.
 *
 * The default has to be *above* the line the active category is resolved at —
 * the bar's height plus its gap, about 96px. At 100 the section is four pixels
 * short of counting, and the test failed on an off-by-four rather than on
 * anything the page does wrong.
 */
async function scrollToSection(page: Page, id: string, offset = 40) {
  await page.evaluate(
    ([target, gap]) => {
      const node = document.getElementById(target as string);
      if (!node) return;
      window.scrollTo({
        top: node.getBoundingClientRect().top + window.scrollY - (gap as number),
        behavior: "auto",
      });
    },
    [id, offset] as const,
  );
}

test("the menu page renders every category and item from the data", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  // Counted against the data module rather than a literal, so adding a category
  // to the menu cannot leave this test passing on a page that dropped it.
  await expect(page.locator(".menu-section")).toHaveCount(MENU.length);
  await expect(page.locator(".cat-pill")).toHaveCount(MENU.length);
  await expect(page.locator(".menu-item")).toHaveCount(ITEM_COUNT);

  // Every category is anchored by its own stable id.
  for (const category of MENU) {
    await expect(page.locator(`#${category.id}`)).toHaveCount(1);
  }

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("the home page links to the menu instead of listing it", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // The teaser rail, not the full menu. If the whole thing ever gets rendered
  // on the home page again, this is what says so.
  await expect(page.locator(".menu-section")).toHaveCount(0);
  await expect(page.locator(".pan-card")).toHaveCount(3);

  await page.getByRole("link", { name: "See the full menu" }).click();
  await expect(page).toHaveURL(/\/menu$/);
  await expect(page.locator(".menu-section").first()).toBeVisible();
  // A route, not a reload: the boot splash belongs to a cold document, and
  // seeing it again would mean the click went to the network.
  await expect(page.locator("#boot-splash")).toHaveCount(0);
});

test("clicking a category scrolls to it, clear of the bar, and marks it active", async ({
  page,
}) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  await page.locator('.cat-pill[data-cat="gateaux"]').click();

  // Polled: the scroll is smooth and its length depends on where the page was.
  await expect
    .poll(() => activePill(page), { timeout: 6000, message: "the pill did not follow the click" })
    .toBe("Gateaux");

  const geometry = await page.evaluate(() => {
    const heading = document.querySelector("#gateaux .menu-section-title")!.getBoundingClientRect();
    const bar = document.querySelector(".cat-nav")!.getBoundingClientRect();
    return { headingTop: Math.round(heading.top), barBottom: Math.round(bar.bottom) };
  });
  // The heading must be *below* the sticky bar, not under it. This is the whole
  // point of the scroll offset, and it is invisible in a screenshot taken a
  // moment too early.
  expect(
    geometry.headingTop,
    `heading at ${geometry.headingTop}, bar ends at ${geometry.barBottom}`,
  ).toBeGreaterThan(geometry.barBottom);

  expect(page.url()).toContain("#gateaux");
});

test("the last category becomes active at the bottom of the page", async ({ page }) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  // The last section is short, so the page hits its bottom stop before that
  // heading can scroll under the bar. Resolved by crossings alone, the bar named
  // the category before it.
  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" }),
  );
  await expect
    .poll(() => activePill(page), { timeout: 5000, message: "the last category never activated" })
    .toBe(MENU[MENU.length - 1].name);
});

test("scrolling by hand moves the active category", async ({ page }) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);
  expect(await activePill(page)).toBe(MENU[0].name);

  for (const id of ["cookie-scoops", "gateaux", "coffee"]) {
    await scrollToSection(page, id);
    await expect
      .poll(() => activePill(page), { timeout: 4000, message: `scrolling to ${id}` })
      .toBe(MENU.find((category) => category.id === id)!.name);
  }
});

test("a deep link lands on the right category, below the bar", async ({ page }) => {
  await page.goto("/menu#biscuits-kahk", { waitUntil: "load" });
  await ready(page);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const heading = document.querySelector("#biscuits-kahk .menu-section-title");
          const bar = document.querySelector(".cat-nav");
          if (!heading || !bar) return -1;
          return Math.round(
            heading.getBoundingClientRect().top - bar.getBoundingClientRect().bottom,
          );
        }),
      { timeout: 6000, message: "the deep link never settled below the bar" },
    )
    .toBeGreaterThan(0);
});

test("the header and the category bar merge on scroll and come back apart", async ({ page }) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  const bars = () =>
    page.evaluate(() => {
      const header = document.querySelector(".site-header")!.getBoundingClientRect();
      const bar = document.querySelector(".cat-nav")!.getBoundingClientRect();
      return {
        headerVisible: header.bottom > 1,
        headerBottom: Math.round(header.bottom),
        barTop: Math.round(bar.top),
      };
    });

  // At the top: stacked, header first.
  const top = await bars();
  expect(top.headerVisible).toBe(true);
  expect(top.barTop).toBeGreaterThan(top.headerBottom);

  await page.evaluate(() => window.scrollTo({ top: 1600, behavior: "auto" }));
  await expect
    .poll(async () => (await bars()).headerVisible, {
      timeout: 4000,
      message: "the header never got out of the way",
    })
    .toBe(false);
  // …and the category bar has taken the top of the screen on its own.
  expect((await bars()).barTop).toBe(0);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await expect
    .poll(async () => (await bars()).headerVisible, {
      timeout: 4000,
      message: "the header never came back",
    })
    .toBe(true);
});

test("the decorative word stays anchored, stays behind, and takes no clicks", async ({ page }) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  const word = page.locator(".menu-word");
  await expect(word).toHaveAttribute; // presence only; it is aria-hidden scenery
  const before = await word.evaluate((el) => Math.round(el.getBoundingClientRect().top));

  await page.evaluate(() => window.scrollTo({ top: 2400, behavior: "auto" }));
  await page.waitForTimeout(400);
  const after = await word.evaluate((el) => Math.round(el.getBoundingClientRect().top));

  // Sticky, so it holds its offset rather than travelling 2400px with the page.
  // Without the fix that made it sticky it was a 5900px-tall box whose text sat
  // at the top and scrolled straight out of view.
  expect(Math.abs(after - before), `word moved from ${before} to ${after}`).toBeLessThan(120);

  const guards = await page.evaluate(() => {
    const rail = document.querySelector(".menu-word-rail")!;
    return {
      hidden: rail.getAttribute("aria-hidden"),
      pointer: getComputedStyle(rail).pointerEvents,
      opacity: Number(getComputedStyle(document.querySelector(".menu-word")!).opacity),
    };
  });
  expect(guards.hidden).toBe("true");
  expect(guards.pointer).toBe("none");
  expect(guards.opacity).toBeLessThan(0.15);

  // And a category directly over it is still clickable.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.locator('.cat-pill[data-cat="molten-cakes"]').click();
  await expect.poll(() => activePill(page), { timeout: 5000 }).toBe("Molten Cakes");
});

test("no horizontal overflow anywhere down the menu", async ({ page }) => {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  for (const y of [0, 1200, 2600, 4200]) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), y);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `overflow at scrollY ${y}`).toBeLessThanOrEqual(0);
  }
});
