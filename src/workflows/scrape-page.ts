import { workflow } from "libretto";

type Output = {
  url: string;
  title: string;
  heading: string;
};

export default workflow<undefined, Output>("scrape-page", async ({ page }) => {
  await page.goto("https://example.com");

  const title = await page.title();
  const heading = await page.locator("h1").innerText();

  return {
    url: page.url(),
    title,
    heading,
  };
});
