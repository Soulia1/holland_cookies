import { test, expect, type Page } from "@playwright/test";

async function checkout(page: Page) {
  await page.goto("/menu");
  await expect(page.locator("#boot-splash")).toHaveCount(0, { timeout: 20_000 });
  const add = page.getByRole("button", { name: "Add Vanilla, Lotus filling to cart" }).first();
  await add.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await add.click();
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.goto("/checkout");
  await page.locator("#firstName").fill("Noha");
  await page.locator("#phone").fill("01016521650");
  await page.locator("#email").fill("noha@example.com");
  await page.getByRole("radio", { name: "Pickup", exact: true }).click();
  await page.locator('input[name="payment"][value="online"]').check();
  await page.getByRole("button", { name: "Pay now", exact: true }).click();
  await expect(page).toHaveURL(/\/api\/payments\/mock\/checkout\?/);
}

test('hosted checkout returns to a confirmed receipt and clears the cart', async ({ page }) => {
  await checkout(page);
  await page.getByRole("link", { name: "Pay EGP 60.00", exact: true }).click();
  await expect(page).toHaveURL(/\/checkout/);
  await expect(page.locator(".rcpt-barcode-text")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rcpt-total-value")).toHaveText("60.00 EGP");
  await expect(page.locator(".cart-badge")).toHaveCount(0);
});

test('decline and browser Back preserve the order, and retry uses the same reference', async ({ page }) => {
  await checkout(page);
  const reference = new URL(page.url()).searchParams.get("ref")!.split("-").slice(0, 2).join("-");
  await page.getByRole("link", { name: "Simulate a declined card" }).click();
  await expect(page.getByRole("heading", { name: `Finish paying for ${reference}` })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("did not go through");
  await expect(page.locator(".cart-badge")).toHaveText("1");
  await page.reload();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/api\/payments\/mock\/checkout\?/);
  expect(new URL(page.url()).searchParams.get("ref")).toMatch(new RegExp(`^${reference}-`));
  await page.goBack();
  await expect(page.getByRole("heading", { name: `Finish paying for ${reference}` })).toBeVisible();
  await expect(page.locator("#firstName")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page.getByRole("link", { name: "Pay EGP 60.00", exact: true }).click();
  await expect(page.locator(".rcpt-barcode-text")).toHaveText(reference);
});
