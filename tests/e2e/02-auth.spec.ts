import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, login } from "./helpers";

test("an unauthenticated visit goes to the sign-in screen", async ({ page }) => {
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to NoConBrain" })).toBeVisible();
});

test("wrong password shows a plain error and stays on the screen", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "wrong" })).toContainText("username or password is wrong");
  await expect(page).toHaveURL(/\/login/);
});

test("empty fields are explained before anything is sent", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter the username.")).toBeVisible();
  await expect(page.getByText("Enter the password.")).toBeVisible();
});

test("sign in, then sign out ends the session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("signed-in-as")).toHaveText(ADMIN_USER);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // The session is gone: a protected page sends the visitor back to sign in.
  await page.goto("/downloads");
  await expect(page).toHaveURL(/\/login/);
});

test("sign-in keeps a safe return path only", async ({ page }) => {
  await page.goto("/login?next=//evil.example");
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Areas" })).toBeVisible();
  expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL!).host);
  await login(page);
});
