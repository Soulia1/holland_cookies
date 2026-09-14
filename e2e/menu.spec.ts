import { expect, test, type Page } from "@playwright/test";
import { ITEM_COUNT, MENU, MENU_GROUPS, groupItemCount } from "../src/data/menu";

// The menu, which is a page per *group* with the group's categories as sections
// on it: routing and its redirects, the two bars, the scrollspy that links the
// second to the page, the pager, the merge with the site header, and the
// decorative word.

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Answer the session probe the way the real server answers a guest.
 *
 * `AuthProvider` asks `/api/account/me` on every page load, and this suite runs
 * against `vite preview` — a static file server with no backend, which hands the
 * SPA fallback back for that path and fails the request. That is a fact about
 * the harness rather than about the page, but it puts a failed-resource error in
 * the console on every single load, which would either drown a real error or
 * force the console assertion below to be dropped entirely.
 *
 * The payload is `backend/routes/account.js`'s own answer for a signed-out
 * visitor: 200 with a null customer, chosen there for exactly this reason — so
 * that the ordinary anonymous case is not console noise.
 */
async function stubSession(page: Page) {
  await page.route("**/api/account/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ customer: null, mailConfigured: true }),
    }),
  );
}

const activePill = (page: Page) =>
  page.evaluate(() => document.querySelector(".cat-pill.is-active")?.textContent ?? null);

const readingChip = (page: Page) =>
  page.evaluate(() => document.querySelector(".subcat-chip.is-reading")?.textContent ?? null);

/** Where the sticky bar's bottom edge is — the line a heading has to clear. */
const barBottom = (page: Page) =>
  page.evaluate(() => document.querySelector(".cat-nav")!.getBoundingClientRect().bottom);

const COOKIES = MENU_GROUPS[0];
const DESSERTS = MENU_GROUPS[1];

test("every group has its own page, carrying exactly its own sections", async ({ page }) => {
  await stubSession(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // Walked against the data module rather than a literal list, so adding a
  // group or moving a category between them cannot leave this passing on a site
  // that does not show it — and the running total is what says no item was
  // dropped or duplicated in the fold from seventeen pages to three.
  let seen = 0;
  for (const group of MENU_GROUPS) {
    await page.goto(`/menu/${group.id}`, { waitUntil: "load" });
    await ready(page);

    await expect(page.locator("h1")).toHaveText(group.name);
    // One section per category in this group, in the group's own order, and
    // nobody else's.
    await expect(page.locator(".menu-section")).toHaveCount(group.categories.length);
    await expect(page.locator(".menu-section-title")).toHaveText(
      group.categories.map((category) => category.name),
    );
    await expect(page.locator(".menu-item")).toHaveCount(groupItemCount(group));
    // The bar carries every group on every page — it is the navigation now —
    // and the second row carries this group's sections.
    await expect(page.locator(".cat-pill")).toHaveCount(MENU_GROUPS.length);
    await expect(page.locator(".subcat-chip")).toHaveCount(group.categories.length);
    expect(await activePill(page)).toBe(group.name);

    for (const category of group.categories) {
      await expect(page.locator(`#${category.id}`)).toHaveCount(1);
    }

    seen += groupItemCount(group);
  }
  expect(seen, "the three pages between them show the whole menu, once").toBe(ITEM_COUNT);

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("the bare /menu redirects to the first group without trapping Back", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // Navigated rather than clicked the header link, because on the phone project
  // that link lives inside a closed drawer and the test would be measuring the
  // hamburger rather than the redirect. `/menu` is the address every link on the
  // site uses, so arriving at it directly is the same journey.
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);

  await expect(page).toHaveURL(new RegExp(`/menu/${COOKIES.id}$`));
  await expect(page.locator("h1")).toHaveText(COOKIES.name);

  // The redirect must replace rather than push. Pushing would put a `/menu`
  // entry in the history whose only effect on Back is to send the reader
  // forward again, which is a trap: one press has to reach the home page.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".bestsellers")).toBeVisible();
});

test("an old per-category address lands on that section of its group", async ({ page }) => {
  // `/menu/cookie-pans` was a real page until the categories were folded into
  // groups, so those addresses are in the wild — bookmarked, shared, and in
  // this project's own history. A category is a section now, and the link still
  // means exactly what it always meant.
  await page.goto("/menu/cookie-pans", { waitUntil: "load" });
  await ready(page);

  await expect(page).toHaveURL(/\/menu\/cookies#cookie-pans$/);
  await expect(page.locator("h1")).toHaveText("Cookies");

  // And it arrives *at* that section rather than at the top of a page that
  // merely contains it, with the heading clear of the sticky bar.
  const landed = await page.evaluate(() => {
    const heading = document.querySelector("#cookie-pans .menu-section-title")!;
    const bar = document.querySelector(".cat-nav")!.getBoundingClientRect();
    return { top: heading.getBoundingClientRect().top, bar: bar.bottom, scrollY: window.scrollY };
  });
  expect(landed.scrollY, "did not scroll to the section at all").toBeGreaterThan(0);
  expect(landed.top, "the heading landed under the sticky bar").toBeGreaterThanOrEqual(landed.bar);
  expect(landed.top - landed.bar, "the heading landed miles below the bar").toBeLessThan(120);
});

test("an old /menu#category deep link lands on that section too", async ({ page }) => {
  // How the original one-page menu deep-linked. Older still, same promise.
  await page.goto("/menu#molten-cakes", { waitUntil: "load" });
  await ready(page);

  await expect(page).toHaveURL(/\/menu\/desserts#molten-cakes$/);
  await expect(page.locator("h1")).toHaveText("Desserts");
  await expect(page.locator("#molten-cakes")).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("a hash naming a section of another group is ignored, not followed", async ({ page }) => {
  // The path is the more specific half of the address. A `#molten-cakes` on the
  // cookies page names nothing there, and quietly rewriting the URL to the
  // desserts page would be the address changing the page rather than the other
  // way round.
  await page.goto("/menu/cookies#molten-cakes", { waitUntil: "load" });
  await ready(page);

  await expect(page).toHaveURL(/\/menu\/cookies$/);
  await expect(page.locator("h1")).toHaveText("Cookies");
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
});

test("a slug that names nothing at all falls back rather than dead-ending", async ({ page }) => {
  await page.goto("/menu/no-such-thing", { waitUntil: "load" });
  await ready(page);

  await expect(page).toHaveURL(new RegExp(`/menu/${COOKIES.id}$`));
  await expect(page.locator("h1")).toHaveText(COOKIES.name);
});

test("the group bar routes between pages without reloading the document", async ({ page }) => {
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);

  // Marked at the top of the page, so this is a route change and not a fetch.
  await page.evaluate(() => {
    (window as unknown as { __alive?: boolean }).__alive = true;
  });

  await page.locator('.cat-pill[data-cat="drinks"]').click();

  await expect(page).toHaveURL(/\/menu\/drinks$/);
  await expect(page.locator("h1")).toHaveText("Drinks");
  expect(await activePill(page)).toBe("Drinks");
  expect(
    await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true),
    "the click reloaded the document instead of routing",
  ).toBe(true);

  // A new page starts at the top, rather than at wherever the last one was left.
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  // And the second row has been rebuilt for the group that is now on screen.
  await expect(page.locator(".subcat-chip")).toHaveText(
    MENU_GROUPS[2].categories.map((category) => category.name),
  );
});

test("a section chip scrolls to its section and clears the sticky bar", async ({ page }) => {
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);

  // The last chip, so the scroll is a long one and the section it lands on is
  // near the bottom — where a wrong offset shows up worst.
  const last = COOKIES.categories[COOKIES.categories.length - 1];
  await page.locator(`.subcat-chip[data-sub="${last.id}"]`).click();

  // Same page: the chip is an in-page anchor, not a navigation.
  await expect(page).toHaveURL(new RegExp(`/menu/cookies#${last.id}$`));

  // Smooth by stylesheet, so polled rather than measured once.
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top),
          last.id,
        ),
      { timeout: 4000, message: "the chip never scrolled to its section" },
    )
    .toBeLessThan(400);

  // Under 400 is not arrived: the smooth scroll may still be travelling, and the
  // header is still sliding out of the bar above it. Measured once both have
  // stopped — two reads 150ms apart that agree — or a slow machine measures the
  // page mid-flight and reports a gap the reader never sees.
  const gap = () =>
    page.evaluate((id) => {
      const barEdge = document.querySelector(".cat-nav")!.getBoundingClientRect().bottom;
      const title = document.querySelector(`#${id} .menu-section-title`)!.getBoundingClientRect().top;
      return Math.round(title - barEdge);
    }, last.id);
  let settled = await gap();
  await expect
    .poll(
      async () => {
        const previous = settled;
        await page.waitForTimeout(150);
        settled = await gap();
        return settled === previous;
      },
      { timeout: 8000, message: "the scroll never came to rest" },
    )
    .toBe(true);

  const bar = await barBottom(page);
  const heading = await page.evaluate(
    (id) => document.querySelector(`#${id} .menu-section-title`)!.getBoundingClientRect().top,
    last.id,
  );
  // The whole point of `scroll-margin-top`: the heading you asked for is the
  // heading you can see, not one hidden behind the bar that took you there.
  expect(heading, `heading at ${heading}, bar bottom at ${bar}`).toBeGreaterThanOrEqual(bar);
  expect(heading - bar).toBeLessThan(120);
});

test("the scrollspy lights the section being read, bottom of the page included", async ({
  page,
}) => {
  await page.goto("/menu/cookies", { waitUntil: "load" });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);

  // At the top: the first section.
  expect(await readingChip(page)).toBe(COOKIES.categories[0].name);

  // Put a middle section's top just past the bar and the chip has to follow.
  // Scrolled by measurement rather than by a guessed pixel count, since section
  // heights depend on which fonts have landed.
  //
  // Twice, and that is not belt and braces. The site header sits above the bar
  // at the top of the page and slides away once the intro has gone by, so the
  // bar's bottom edge measured at rest is ~88px lower than where it will be
  // after any scroll worth making. Measuring once, scrolling, and asserting
  // lands the section that far off and reads the *previous* one — which is what
  // this test did on its first run, and which is a fact about the header rather
  // than about the spy.
  const middle = COOKIES.categories[3];
  const place = (id: string) =>
    page.evaluate((target) => {
      const bar = document.querySelector(".cat-nav")!.getBoundingClientRect().bottom;
      const top = document.getElementById(target)!.getBoundingClientRect().top;
      window.scrollTo({ top: window.scrollY + top - bar + 8, behavior: "auto" });
    }, id);

  await place(middle.id);
  await page.waitForTimeout(150);
  await place(middle.id);

  await expect
    .poll(() => readingChip(page), { timeout: 4000, message: "the spy did not follow the scroll" })
    .toBe(middle.name);

  // The bottom of the page is its own case and not an optimisation: the last
  // section is shorter than a viewport, so its top never reaches the line and
  // it could otherwise never light however far down the reader goes.
  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" }),
  );
  await expect
    .poll(() => readingChip(page), {
      timeout: 4000,
      message: "the last section never lit at the bottom of the page",
    })
    .toBe(COOKIES.categories[COOKIES.categories.length - 1].name);

  // Exactly one chip claims to be the one being read, at every position above.
  expect(await page.locator(".subcat-chip.is-reading").count()).toBe(1);
});

test("the indicator sits exactly under the active pill, after the fonts land", async ({ page }) => {
  // The pills are laid out in the fallback font and re-laid-out when the real
  // one arrives. Measured once and never again, the indicator ends up beside
  // the pill rather than under it — which is what happened in Arabic, where
  // Cairo narrows every label.
  await page.goto("/menu/desserts", { waitUntil: "load" });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);

  const drift = await page.evaluate(() => {
    const pill = document.querySelector(".cat-pill.is-active")!.getBoundingClientRect();
    const indicator = document.querySelector(".cat-indicator")!.getBoundingClientRect();
    return {
      left: Math.round(indicator.left - pill.left),
      width: Math.round(indicator.width - pill.width),
    };
  });
  expect(Math.abs(drift.left), `indicator ${drift.left}px off the pill`).toBeLessThanOrEqual(1);
  expect(Math.abs(drift.width)).toBeLessThanOrEqual(1);
});

test("the pager walks the groups in order and stops at both ends", async ({ page }) => {
  const [first, second] = MENU_GROUPS;
  const last = MENU_GROUPS[MENU_GROUPS.length - 1];

  // The first page has a next and no previous…
  await page.goto(`/menu/${first.id}`, { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".menu-pager-link.is-prev")).toHaveCount(0);
  await expect(page.locator(".menu-pager-link.is-next")).toContainText(second.name);

  await page.locator(".menu-pager-link.is-next").click();
  await expect(page).toHaveURL(new RegExp(`/menu/${second.id}$`));
  await expect(page.locator(".menu-pager-link.is-prev")).toContainText(first.name);

  // …and the last has a previous and no next.
  await page.goto(`/menu/${last.id}`, { waitUntil: "load" });
  await ready(page);
  await expect(page.locator(".menu-pager-link.is-next")).toHaveCount(0);
  await expect(page.locator(".menu-pager-link.is-prev")).toContainText(
    MENU_GROUPS[MENU_GROUPS.length - 2].name,
  );
});

test("the home page links to the menu instead of listing it", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // The teaser rail, not the menu. If the whole thing ever gets rendered on the
  // home page again, this is what says so.
  await expect(page.locator(".menu-section")).toHaveCount(0);
  await expect(page.locator(".pan-card")).toHaveCount(3);

  await page.getByRole("link", { name: "See the full menu" }).click();
  await expect(page).toHaveURL(new RegExp(`/menu/${COOKIES.id}$`));
  await expect(page.locator(".menu-item").first()).toBeVisible();
  // A route, not a reload: the boot splash belongs to a cold document, and
  // seeing it again would mean the click went to the network.
  await expect(page.locator("#boot-splash")).toHaveCount(0);
});

test("the header and the category bar merge on scroll and come back apart", async ({ page }) => {
  await page.goto("/menu/cookies", { waitUntil: "load" });
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

  await page.evaluate(() => window.scrollTo({ top: 600, behavior: "auto" }));
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

test("the decorative word stays behind, takes no clicks, and fits its page", async ({ page }) => {
  // The shortest group. Grouping made every page taller than the per-category
  // pages were, but the word is still sized to fit inside the shortest of them —
  // too large and it overflows the rail and paints down over the footer, which
  // is invisible to every other check here.
  await page.goto(`/menu/${MENU_GROUPS[MENU_GROUPS.length - 1].id}`, { waitUntil: "load" });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);

  const word = page.locator(".menu-word");
  const before = await word.evaluate((el) => Math.round(el.getBoundingClientRect().top));

  const fits = await page.evaluate(() => {
    const w = document.querySelector(".menu-word")!.getBoundingClientRect();
    const page = document.querySelector(".menu-page")!.getBoundingClientRect();
    return { overhang: Math.round(w.bottom - page.bottom), height: Math.round(w.height) };
  });
  expect(fits.overhang, "the word hangs out of the bottom of its page").toBeLessThanOrEqual(0);
  // And it is still a spine rather than a smudge — the failure mode in Arabic,
  // where the same font-size buys less than half the length.
  expect(fits.height).toBeGreaterThan(150);

  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "auto" }));
  await page.waitForTimeout(300);
  const after = await word.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // Sticky, so it holds its offset rather than travelling with the page.
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

  // And a pill directly over it is still clickable.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.locator(`.cat-pill[data-cat="${DESSERTS.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/menu/${DESSERTS.id}$`));
});

test("no horizontal overflow on the longest group or the shortest", async ({ page }) => {
  // Cookies is seven sections and the widest second row; Drinks is four and the
  // shortest page. Two bars that scroll sideways are two more chances for
  // something to push the document wider than the viewport.
  for (const id of [COOKIES.id, MENU_GROUPS[MENU_GROUPS.length - 1].id]) {
    await page.goto(`/menu/${id}`, { waitUntil: "load" });
    await ready(page);
    for (const y of [0, 400, 900, 2400]) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), y);
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `overflow on ${id} at scrollY ${y}`).toBeLessThanOrEqual(0);
    }
  }
});

test("no category was orphaned by the grouping", async ({ page }) => {
  // The quiet failure this whole restructure risks: a category that no group
  // claims does not throw and does not look broken — it just stops existing.
  // `menu.test.ts` proves the data agrees with itself; this proves the running
  // site agrees with the data, by asking the browser for every category id.
  await stubSession(page);
  const reachable = new Set<string>();
  for (const group of MENU_GROUPS) {
    await page.goto(`/menu/${group.id}`, { waitUntil: "load" });
    await ready(page);
    for (const id of await page.locator(".menu-section").evaluateAll((nodes) =>
      nodes.map((node) => node.id),
    )) {
      reachable.add(id);
    }
  }
  expect([...reachable].sort()).toEqual(MENU.map((category) => category.id).sort());
});
