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

/** The cookie pans the shop sells right now: what the home page rail shows. */
async function railPans(page: Page): Promise<{ id: string; name: string }[]> {
  const menu = await (await page.request.get("/api/menu")).json();
  const pans = menu.categories.find((category: { id: string }) => category.id === "cookie-pans");
  return (pans?.items ?? []).filter((item: { available: boolean }) => item.available);
}

test("the home page cards are the shop's cookie pans, and all reveal on scroll", async ({ page }) => {
  const pans = await railPans(page);
  expect(pans.length, "the seeded shop has cookie pans to show").toBeGreaterThan(2);
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  const cards = page.locator(".pan-card");
  await expect(cards).toHaveCount(pans.length);
  await expect(cards.first()).toContainText(pans[0].name);

  // Each card is brought into view in turn, and `scrollIntoViewIfNeeded` is
  // load-bearing rather than convenience: the cards live in a horizontal rail,
  // so the third is off the right edge of its own scroll container at most
  // viewports. An IntersectionObserver clips against every ancestor scroller, so
  // a card outside the rail genuinely is not intersecting and correctly has not
  // revealed — scrolling the *page* to it would prove nothing. This moves both
  // axes, which is what a visitor reaching that card does too.
  for (let i = 0; i < pans.length; i += 1) {
    await cards.nth(i).scrollIntoViewIfNeeded();
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

/** The pan's current rotation in degrees, read off the element's own matrix. */
async function panAngle(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return NaN;
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") return 0;
    const [a, b] = t.replace(/matrix\(|\)/g, "").split(",").map(Number);
    return Math.round((Math.atan2(b, a) * 180) / Math.PI);
  }, selector);
}

/** The value Hero.tsx writes for the scroll-driven turn. */
async function scrollSpin(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".hero-pan-spin");
    return parseFloat(el?.style.getPropertyValue("--pan-spin") ?? "0") || 0;
  });
}

test("the whole hero fits one screen", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // The composition is a pan bleeding off the bottom of the *viewport*. When the
  // hero grew past the viewport instead, the pan bled off the bottom of a
  // section that was itself below the fold — which looks, on landing, like a
  // page that simply stops. Worth pinning: it is invisible at the viewport the
  // design is drawn at and wrong at every shorter one.
  const fit = await page.evaluate(() => ({
    hero: Math.round(document.querySelector(".hero")!.getBoundingClientRect().height),
    viewport: window.innerHeight,
  }));
  expect(fit.hero, `hero ${fit.hero}px in a ${fit.viewport}px viewport`).toBeLessThanOrEqual(
    fit.viewport + 1,
  );
});

test("the pan turns on arrival and settles square", async ({ page }) => {
  // Recorded from inside the page, every frame. Sampling from the driver after a
  // fixed delay measures whichever animation is still in flight — the same trap
  // this suite already documents for the reveal and the header.
  await page.addInitScript(() => {
    const angles: number[] = [];
    const running: number[] = [];
    (window as unknown as { __panAngles: number[] }).__panAngles = angles;
    (window as unknown as { __panRunning: number[] }).__panRunning = running;
    const started = performance.now();
    const tick = () => {
      const el = document.querySelector(".hero-pan-entry");
      if (el) {
        // The turn as the browser itself reports it: a running CSS animation and
        // its duration. Independent of how many frames a slow renderer paints.
        for (const animation of el.getAnimations()) {
          if ((animation as CSSAnimation).animationName === "pan-spin-in" && animation.playState === "running") {
            running.push(Number(animation.effect?.getComputedTiming().duration) || 0);
          }
        }
        const t = getComputedStyle(el).transform;
        if (!t || t === "none") angles.push(0);
        else {
          const [a, b] = t.replace(/matrix\(|\)/g, "").split(",").map(Number);
          angles.push(Math.round((Math.atan2(b, a) * 180) / Math.PI));
        }
      }
      if (performance.now() - started < 6000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // Polled, not slept: the turn is 1800ms behind a decode of unknown length.
  await expect
    .poll(() => panAngle(page, ".hero-pan-entry"), {
      timeout: 8000,
      message: "the pan never settled square",
    })
    .toBe(0);

  const angles = await page.evaluate(
    () => (window as unknown as { __panAngles: number[] }).__panAngles,
  );
  // It has to have actually turned. Without this the test passes on a pan that
  // was never rotated in the first place — the animation silently not running is
  // exactly the failure worth catching.
  expect(Math.min(...angles), "the pan never left its start angle").toBeLessThan(-60);
  // And it has to have turned rather than jumped. Counting painted frames made
  // this depend on the machine: a software renderer in CI paints three frames of
  // an 1800ms turn and failed a turn that was running perfectly. So: the browser
  // must report the arrival animation running at its full length, and at least
  // one sample must have caught the pan between its start angle and square.
  const running = await page.evaluate(
    () => (window as unknown as { __panRunning: number[] }).__panRunning,
  );
  expect(running.length, "the arrival turn never ran as an animation").toBeGreaterThan(0);
  expect(Math.max(...running), "the turn was a jump, not an animation").toBeGreaterThanOrEqual(1000);
  const midFlight = angles.filter((a) => a < -8 && a > -110).length;
  expect(midFlight, "no sample caught the pan mid-turn").toBeGreaterThan(0);
});

test("the pan turns as the hero scrolls past, then stops", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  const heroHeight = await page.evaluate(
    () => (document.querySelector(".hero") as HTMLElement).offsetHeight,
  );
  expect(await scrollSpin(page)).toBe(0);

  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }),
    Math.round(heroHeight / 2),
  );
  // rAF-driven, so the write lands a frame after the scroll.
  await expect
    .poll(() => scrollSpin(page), { timeout: 3000, message: "the pan did not turn on scroll" })
    .toBeGreaterThan(8);

  // Capped once the hero is behind you — an uncapped version keeps winding for
  // the length of the page and the pan is upside down by the footer.
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }),
    heroHeight * 3,
  );
  // Polled up to the cap, not sampled right after the scroll. WebKit does not
  // honour `behavior: "instant"` — it inherits the stylesheet's smooth scroll —
  // so an immediate read here catches the value the page had two screens ago.
  await expect
    .poll(() => scrollSpin(page), { timeout: 6000, message: "the turn never reached its cap" })
    .toBeGreaterThan(24);
  // …and never past it. An uncapped version keeps winding for the length of the
  // page, and the pan is upside down by the footer.
  expect(await scrollSpin(page)).toBeLessThanOrEqual(26);
});

test("under reduced motion neither turn runs, and nothing is left hidden behind one", async ({
  page,
}) => {
  {
    // `emulateMedia` rather than `test.use({ reducedMotion })`: the option is
    // rejected by this version's `test.use` typing, and emulating before the
    // first navigation is equivalent — the page never renders unemulated.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "load" });
    await ready(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: "instant" as ScrollBehavior }));
    await page.waitForTimeout(400);

    const state = await page.evaluate(() => ({
      spin: getComputedStyle(document.querySelector(".hero-pan-spin")!).transform,
      entry: getComputedStyle(document.querySelector(".hero-pan-entry")!).transform,
      spinVar:
        document.querySelector<HTMLElement>(".hero-pan-spin")!.style.getPropertyValue("--pan-spin"),
      stage: getComputedStyle(document.querySelector(".hero-stage")!).opacity,
      title: getComputedStyle(document.querySelector(".hero-title")!).opacity,
      crumbs: [...document.querySelectorAll(".crumb")].map((c) => getComputedStyle(c).opacity),
    }));

    expect(state.entry, "the arrival turn ran under reduced motion").toBe("none");
    expect(state.spin, "the scroll turn ran under reduced motion").toBe("none");
    expect(state.spinVar, "the scroll listener wrote a value it should not have").toBe("");
    // The other half of the contract, and the one that actually breaks pages:
    // removing the motion must never leave the content it was carrying at zero.
    expect(state.stage).toBe("1");
    expect(state.title).toBe("1");
    expect(state.crumbs.every((o) => o === "1"), `crumb opacities ${state.crumbs}`).toBe(true);
  }
});

test("content the viewport jumps clean past still reveals", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await ready(page);

  // One instantaneous move, from the top of the page to Our Craft — the last
  // section. That carries the bestsellers rail from below the viewport to
  // above it inside a single frame, so neither of its revealed blocks ever
  // intersects.
  //
  // An IntersectionObserver reports where its targets are when it delivers, not
  // every position they passed through, so a target that is below on one
  // delivery and above on the next crosses no threshold and gets no callback at
  // all. Before reveal.tsx swept for this, those blocks stayed at opacity 0 for
  // the life of the page — content permanently hidden behind an effect that
  // never ran. It is the same failure the header hit with a 1px sentinel.
  //
  // The jump used to land on the Visit section, which sat below Our Craft, then
  // on Build Your Box once Visit was removed. Both sections are gone and Our
  // Craft is now the one right after the bestsellers rail, so the skipped
  // content is the rail itself. Landing on the footer instead would prove
  // nothing: the footer holds no revealed elements, so the delivery that
  // triggers the sweep would never happen and the assertion would fail whether
  // the sweep worked or not.
  await page.locator("#craft").evaluate((el) => {
    const y = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
  });

  await expect
    .poll(
      async () =>
        page.locator("#menu .bestsellers-head, #menu .rail-item").evaluateAll((nodes) =>
          nodes.length === 0
            ? -1
            : Math.min(...nodes.map((n) => Number(getComputedStyle(n).opacity))),
        ),
      { timeout: 6000, message: "jumped-past content never revealed" },
    )
    .toBeGreaterThan(0.9);
});

test("the detail dialog opens, traps focus, closes on Escape, and restores focus", async ({
  page,
}) => {
  const [firstPan] = await railPans(page);
  await page.goto("/", { waitUntil: "load" });
  await ready(page);
  await page.locator("#menu").scrollIntoViewIfNeeded();

  const firstCard = page.locator(".pan-card").first();
  await firstCard.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(firstPan.name);

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

  for (const id of ["menu", "craft"]) {
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
    for (const id of ["menu", "craft"]) {
      await page.evaluate((t) => document.getElementById(t)?.scrollIntoView(), id);
      await page.waitForTimeout(200);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `horizontal overflow at #${id}`).toBe(false);
    }
  });
});
