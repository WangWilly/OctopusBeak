// Spending shows one month at a time behind previous/next buttons.
export async function chooseSpendingMonth(page, month) {
  const panel = page.locator("[data-month-panel]");
  for (let step = 0; step < 120; step += 1) {
    const current = await panel.getAttribute("data-month");
    if (current === month) return;
    const button = panel.locator(".month-nav button").nth(current > month ? 0 : 1);
    if (await button.isDisabled()) throw new Error(`Spending month ${month} is not reachable from ${current}`);
    await button.click();
    await page.waitForFunction(
      (previous) => document.querySelector("[data-month-panel]")?.getAttribute("data-month") !== previous,
      current,
    );
  }
  throw new Error(`Spending month ${month} was not reached`);
}
