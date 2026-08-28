import { expect, test, type Page } from "@playwright/test";

// Boot-splash lifecycle: does the loader actually reach the screen, every time?
//
// The assertion this suite is built around is a timing one, not a presence one.
// Asking "is #boot-splash in the document" answers yes right up until the moment
// it stops mattering: a splash can be present, correctly styled, and correctly
// removed, and still never be drawn — removed a few milliseconds before the
// browser's own first contentful paint. On WebKit that is a ~20ms margin, which
// lands on either side of the line depending on how fast the bundle parsed. Same
// phone, splash on one reload and no splash on the next.
//
// So the test is: was the splash still on screen at First Contentful Paint? The
// inline SVG mark is the only contentful thing in it and paints before anything
// else on the page, so an FCP that lands after the splash left is an FCP of the
// application — proof the visitor's first sight of the site was the site.

interface SplashProbe {
  fcp: number | null;
  removedAt: number | null;
  markBox: { width: number; height: number } | null;
}

/**
 * Records the two timestamps the whole suite turns on, before any application
 * code runs: when the browser first painted content, and when the splash left
 * the DOM. Installed with addInitScript so it is watching from page creation.
 */
function installProbe(page: Page) {
  return page.addInitScript(() => {
    const store: SplashProbe = { fcp: null, removedAt: null, markBox: null };
    (window as unknown as { __probe: SplashProbe }).__probe = store;

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") store.fcp = entry.startTime;
      }
    }).observe({ type: "paint", buffered: true });

    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if ((node as Element).id === "boot-splash" && store.removedAt === null) {
            store.removedAt = performance.now();
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });

    // The mark's painted box, sampled on the first frame the browser draws. A
    // splash that is present but zero-height is not a loading screen — and an
    // inline SVG with no intrinsic dimensions collapses to exactly that on
    // older WebKit.
    requestAnimationFrame(() => {
      const mark = document.querySelector("#boot-splash .bs-mark");
      if (!mark) return;
      const rect = mark.getBoundingClientRect();
      store.markBox = { width: rect.width, height: rect.height };
    });
  });
}

function readProbe(page: Page): Promise<SplashProbe> {
  return page.evaluate(() => (window as unknown as { __probe: SplashProbe }).__probe);
}

/** The load is only correct if the splash was still on screen when the browser
 *  first painted content, and left afterwards rather than being skipped. */
function expectSplashWasSeen(probe: SplashProbe, label: string) {
  expect(probe.fcp, `${label}: no first-contentful-paint was recorded`).not.toBeNull();
  expect(probe.removedAt, `${label}: the splash was never removed, a stuck loader`)
    .not.toBeNull();
  expect(
    probe.removedAt as number,
    `${label}: the splash left the DOM before first contentful paint, so the `
      + `visitor's first sight of the page was the website itself`,
  ).toBeGreaterThan(probe.fcp as number);
  expect(probe.markBox, `${label}: the mark had no box on the first frame`).not.toBeNull();
  expect((probe.markBox as { width: number }).width).toBeGreaterThan(0);
  expect((probe.markBox as { height: number }).height).toBeGreaterThan(0);
}

/** Nothing from the boot sequence may be left over the finished page. */
async function expectNoResidue(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const residue = await page.evaluate(() => {
    const root = document.getElementById("root");
    const topmost = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    );
    return {
      rootTransformed: !!root?.classList.contains("is-entering"),
      blockedBySplash: !!topmost?.closest("#boot-splash"),
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  });
  expect(residue.rootTransformed).toBe(false);
  expect(residue.blockedBySplash).toBe(false);
  expect(residue.bodyOverflow).not.toBe("hidden");
}

test("the splash stands up on its own, with the bundle blocked entirely", async ({
  page,
}) => {
  // The invariant is not "the markup is present at commit" — that only measures
  // how fast the parser is. It is that a visitor whose bundle is slow, blocked
  // by a proxy, or simply broken still gets a loading screen rather than a bare
  // page. So the bundle is aborted outright and the splash has to hold up with
  // no JavaScript at all: styled by the document, visible by default, covering
  // the viewport.
  await page.route("**/assets/*.js", (route) => route.abort("failed"));

  // `load`, not `domcontentloaded`. WebKit holds style resolution while any
  // render-blocking stylesheet is still in flight, so computed values read at
  // DOMContentLoaded come back as initial values — `position: static` on an
  // element the document plainly styles as fixed. That is an artefact of
  // measuring too early, not a defect, and asserting on it would have been a
  // test that fails for a reason unrelated to what it claims to check.
  //
  // Nothing removes the splash here anyway: the bundle is blocked, and the
  // splash's only remover is JavaScript. The CSS failsafe does not fire for 4s,
  // which is well after this assertion runs.
  await page.goto("/", { waitUntil: "load" });
  const initial = await page.evaluate(() => {
    const el = document.getElementById("boot-splash");
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      position: style.position,
      opacity: Number(style.opacity),
      visibility: style.visibility,
      display: style.display,
      covers: el.getBoundingClientRect().height >= window.innerHeight - 1,
    };
  });
  expect(initial, "no splash in the document with the bundle blocked").not.toBeNull();
  // Visible by default. The splash must never depend on JavaScript adding a
  // class to make it appear — that is the failure mode where a slow or broken
  // bundle shows the visitor a bare page instead of a loading screen.
  expect(initial?.position).toBe("fixed");
  expect(initial?.opacity).toBe(1);
  expect(initial?.visibility).toBe("visible");
  expect(initial?.display).not.toBe("none");
  expect(initial?.covers, "the splash does not cover the viewport").toBe(true);
});

test("repeated cold loads all show the splash", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const runs = testInfo.project.name === "iphone" ? 20 : 8;
  const failures: string[] = [];

  for (let i = 0; i < runs; i += 1) {
    // A fresh context per iteration is a genuinely cold cache each time.
    const context = await browser.newContext();
    const page = await context.newPage();
    await installProbe(page);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
    try {
      expectSplashWasSeen(await readProbe(page), `cold load ${i + 1}`);
      await expectNoResidue(page);
    } catch (error) {
      failures.push(`#${i + 1}: ${(error as Error).message}`);
    }
    await context.close();
  }

  expect(failures, `${failures.length}/${runs} cold loads failed`).toEqual([]);
});

test("warm-cache loads still show the splash", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const runs = testInfo.project.name === "iphone" ? 10 : 5;
  // One context throughout, so every measured load reuses the primed cache.
  // This is the case that used to remove the splash inside its own first frame:
  // readiness resolves in a microtask, before the browser has drawn anything.
  const context = await browser.newContext();
  const primer = await context.newPage();
  await primer.goto("/", { waitUntil: "load" });
  await expect(primer.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
  await primer.close();

  const failures: string[] = [];
  for (let i = 0; i < runs; i += 1) {
    const page = await context.newPage();
    await installProbe(page);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
    try {
      expectSplashWasSeen(await readProbe(page), `warm load ${i + 1}`);
    } catch (error) {
      failures.push(`#${i + 1}: ${(error as Error).message}`);
    }
    await page.close();
  }
  await context.close();
  expect(failures, `${failures.length}/${runs} warm loads failed`).toEqual([]);
});

test("rapid repeated reloads never skip or strand the splash", async ({ page }) => {
  test.setTimeout(120_000);
  for (let i = 0; i < 6; i += 1) {
    await installProbe(page);
    if (i === 0) await page.goto("/", { waitUntil: "load" });
    else await page.reload({ waitUntil: "load" });
    await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
    expectSplashWasSeen(await readProbe(page), `reload ${i + 1}`);
    await expectNoResidue(page);
  }
});

test("a delayed hero image keeps the splash up until it is ready", async ({ page }) => {
  await page.route("**/img/cookie-plate*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await installProbe(page);
  await page.goto("/", { waitUntil: "commit" });
  // Still up well after the minimum-visible window would have expired, because
  // the hold — not a timer — is what is keeping it there.
  await page.waitForTimeout(600);
  await expect(page.locator("#boot-splash")).toBeAttached();
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
  expectSplashWasSeen(await readProbe(page), "delayed hero");
  await expectNoResidue(page);
});

test("a hero image that never arrives still releases the page", async ({ page }) => {
  await page.route("**/img/cookie-plate*", (route) => route.abort("failed"));
  await installProbe(page);
  await page.goto("/", { waitUntil: "load" });
  // Bounded by IMAGE_WAIT_CEILING_MS in Hero.tsx (8s), itself inside the
  // is-held failsafe in index.html (14s). It must never hang.
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 15_000 });
  expectSplashWasSeen(await readProbe(page), "failed hero image");
  await expect(page.locator("h1")).toBeVisible();
  await expectNoResidue(page);
});

test("a restored page is left clean, with no stale overlay or transformed root", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });

  // Playwright's WebKit does not serve pages from the back-forward cache — a
  // back navigation here re-executes the document and reports `persisted:
  // false` — so a real restore cannot be driven from this suite. What can be
  // pinned is the handler's contract: given a document cached mid-boot, with
  // the splash still up and #root still carrying the entry transform, a
  // persisted pageshow must clear both rather than leave an overlay over a page
  // that has already finished.
  await page.evaluate(() => {
    const stale = document.createElement("div");
    stale.id = "boot-splash";
    document.body.appendChild(stale);
    document.getElementById("root")?.classList.add("is-entering");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });

  await expectNoResidue(page);
  // And the page is still usable afterwards.
  const scrolled = await page.evaluate(() => {
    window.scrollTo({ top: 300, behavior: "instant" });
    return window.scrollY;
  });
  expect(scrolled).toBeGreaterThan(0);
});

test.describe("reduced motion", () => {
  // Emulated per page rather than declared with `test.use({ reducedMotion })`.
  // That form does not reliably reach the page under a webServer config, and a
  // test that silently exercises the ordinary path while reading as
  // reduced-motion coverage is how this class of bug survives a suite that
  // already has a reduced-motion case. The preference is asserted below rather
  // than assumed.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  async function expectReducedMotionActive(page: Page) {
    const active = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(active, "reduced motion was not emulated; this test proves nothing").toBe(true);
  }

  // The regression this whole file is modelled on. Under reduced motion the
  // exit animation is skipped entirely, which removes the accidental delay that
  // was hiding the race — so this is the configuration where a splash that is
  // not paint-gated fails most reliably.
  test("the loader is still painted, and still leaves", async ({ page }) => {
    await installProbe(page);
    await page.goto("/", { waitUntil: "load" });
    await expectReducedMotionActive(page);
    await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
    const probe = await readProbe(page);
    expectSplashWasSeen(probe, "reduced motion");
    // Reduced motion removes the mark's movement, not the loading screen: it
    // must be on screen for a real interval, not a single frame.
    expect(
      (probe.removedAt as number) - (probe.fcp as number),
      "the splash was on screen for less than a readable moment",
    ).toBeGreaterThan(100);
    await expectNoResidue(page);
  });

  test("repeated reduced-motion loads are consistent", async ({ browser }) => {
    test.setTimeout(240_000);
    const failures: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      await installProbe(page);
      await page.goto("/", { waitUntil: "load" });
      await expectReducedMotionActive(page);
      await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
      try {
        expectSplashWasSeen(await readProbe(page), `reduced-motion load ${i + 1}`);
      } catch (error) {
        failures.push(`#${i + 1}: ${(error as Error).message}`);
      }
      await context.close();
    }
    expect(failures, `${failures.length}/10 reduced-motion loads failed`).toEqual([]);
  });

  test("the mark's continuous idle motion is disabled", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectReducedMotionActive(page);
    // Read existence and computed style in one evaluate — two round trips race
    // the element's own removal.
    const animation = await page.evaluate(() => {
      const el = document.querySelector("#boot-splash .bs-pan");
      return el ? getComputedStyle(el).animationName : null;
    });
    if (animation !== null) expect(animation).toBe("none");
  });
});
