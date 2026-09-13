import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Customer accounts, end to end.
 *
 * The interesting property is not "sign-in works" — it is that signing in
 * attaches the orders somebody already placed as a guest. That is the whole
 * reason the account exists on a shop like this, and it is the part that would
 * silently rot: the linking happens in one transaction in `claimProfile`, and
 * nothing else in the suite would notice if it stopped.
 *
 * The code is read out of the e2e server's own log. That is not a shortcut
 * around the security model — it is the delivery channel in development, and
 * reading it is exactly what a developer does by hand.
 */

const SERVER_LOG = process.env.HOLLAND_E2E_LOG;

async function ready(page: Page) {
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
}

/** A fresh address per test, so quotas and live codes never collide. */
function freshEmail(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/**
 * The last code the server printed for this address.
 *
 * Polled, because the request returns as soon as the mail transport accepts it
 * and the log line is written on the same tick — but the file the server writes
 * to is buffered, so a single read straight after the click is a race.
 */
async function codeFor(email: string): Promise<string> {
  if (!SERVER_LOG) {
    throw new Error("HOLLAND_E2E_LOG is not set — the suite cannot read the sign-in code.");
  }
  let found: string | undefined;
  await expect
    .poll(
      () => {
        const log = readFileSync(SERVER_LOG, "utf8");
        // The mail block prints the recipient and then the subject carrying the
        // code, so the match has to be anchored to this address rather than to
        // whichever code was printed most recently overall.
        const blocks = log.split("[holland:mail]");
        for (const block of blocks.reverse()) {
          if (!block.includes(email)) continue;
          const match = block.match(/sign-in code: (\d{6})/);
          if (match) { found = match[1]; return true; }
        }
        return false;
      },
      { timeout: 10_000, message: `no sign-in code was logged for ${email}` },
    )
    .toBe(true);
  return found!;
}

/** Place an order as a guest, with the given email. Returns its reference. */
async function orderAsGuest(page: Page, email: string): Promise<string> {
  await page.goto("/menu", { waitUntil: "load" });
  await ready(page);
  const add = page.getByRole("button", { name: "Add Vanilla to cart" }).first();
  // Centred first: scrolled only "into view" on a phone, the row lands under the
  // sticky category bar, which moves as the header condenses and takes the tap.
  await add.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await add.click();
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

  await page.locator("#firstName").fill("Noha");
  await page.locator("#lastName").fill("Ibrahim");
  await page.locator("#phone").fill("01016521650");
  await page.locator("#email").fill(email);
  await page.locator("#area").selectOption("nasr-city");
  await page.locator("#address").fill("27 Mohamed El-Moqrif Street");
  await page.getByRole("button", { name: "Place order" }).click();

  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  return page.locator(".rcpt-barcode-text").innerText();
}

async function signIn(page: Page, email: string) {
  await page.goto("/account", { waitUntil: "load" });
  await ready(page);
  await page.locator("#signin-email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.locator("#signin-code")).toBeVisible({ timeout: 15_000 });

  const code = await codeFor(email);
  await page.locator("#signin-code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#ac-name")).toBeVisible({ timeout: 15_000 });
  return code;
}

test.describe("signing in", () => {
  test("a wrong code is refused and the right one is accepted", async ({ page }) => {
    const email = freshEmail();
    await page.goto("/account", { waitUntil: "load" });
    await ready(page);

    await page.locator("#signin-email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.locator("#signin-code")).toBeVisible({ timeout: 15_000 });

    await page.locator("#signin-code").fill("000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".ed-alert")).toBeVisible();
    await expect(page.locator("#ac-name")).toHaveCount(0);

    await page.locator("#signin-code").fill(await codeFor(email));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#ac-name")).toBeVisible({ timeout: 15_000 });
  });

  test("a used code cannot be replayed", async ({ page }) => {
    const email = freshEmail();
    const code = await signIn(page, email);

    // Sign out, then try the code that just worked. It was consumed on use, so
    // a copy of it — from a forwarded email, a shared screen — is worthless.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#signin-email")).toBeVisible();

    await page.locator("#signin-email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.locator("#signin-code")).toBeVisible({ timeout: 15_000 });
    await page.locator("#signin-code").fill(code);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".ed-alert")).toBeVisible();
  });

  test("the session survives a reload", async ({ page }) => {
    await signIn(page, freshEmail());
    await page.reload({ waitUntil: "load" });
    await ready(page);
    // Straight to the signed-in page, with no sign-in form in between.
    await expect(page.locator("#ac-name")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#signin-email")).toHaveCount(0);
  });

  test("signing out really ends the session", async ({ page }) => {
    await signIn(page, freshEmail());
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#signin-email")).toBeVisible();

    await page.reload({ waitUntil: "load" });
    await ready(page);
    await expect(page.locator("#signin-email")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("the account", () => {
  test("attaches orders placed as a guest before signing in", async ({ page }) => {
    const email = freshEmail();
    const reference = await orderAsGuest(page, email);

    await signIn(page, email);

    // The order placed before the account existed is now in its history.
    await expect(page.locator(".ed-order-ref")).toHaveText(reference);
    // And the customer is told it happened rather than it appearing silently.
    await expect(page.getByRole("status").first()).toContainText("1 earlier order");
  });

  test("fills the profile in from the last order", async ({ page }) => {
    const email = freshEmail();
    await orderAsGuest(page, email);
    await signIn(page, email);

    // Backfilled by claimProfile, so a first sign-in is not a blank form.
    await expect(page.locator("#ac-name")).toHaveValue("Noha Ibrahim");
    await expect(page.locator("#ac-phone")).toHaveValue("01016521650");
    await expect(page.locator("#ac-address")).toHaveValue("27 Mohamed El-Moqrif Street");
  });

  test("saves an edited profile", async ({ page }) => {
    const email = freshEmail();
    await orderAsGuest(page, email);
    await signIn(page, email);

    await page.locator("#ac-name").fill("Noha I.");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await page.reload({ waitUntil: "load" });
    await ready(page);
    await expect(page.locator("#ac-name")).toHaveValue("Noha I.", { timeout: 15_000 });
  });

  test("shows nothing to a signed-out visitor", async ({ page }) => {
    await page.goto("/account", { waitUntil: "load" });
    await ready(page);
    await expect(page.locator("#signin-email")).toBeVisible();
    await expect(page.locator(".ed-order-ref")).toHaveCount(0);
    // Tracking without an account is offered rather than hidden behind it.
    await expect(page.getByRole("link", { name: "Track this order" })).toBeVisible();
  });
});
