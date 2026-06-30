import type { Frame, Locator, Page } from "playwright";

type BrowserScope = Page | Frame;

export async function fetchFormPostbackHtml(
  form: Locator,
  submitFieldName?: string,
  fields: Record<string, string> = {},
): Promise<string> {
  return await form.evaluate(async (element, options) => {
    if (!(element instanceof HTMLFormElement)) {
      throw new Error("Postback target is not a form element.");
    }

    const body = new URLSearchParams();
    for (const [key, value] of new FormData(element)) {
      body.append(key, String(value));
    }
    if (options.submitFieldName) {
      body.set(options.submitFieldName, options.submitFieldName);
    }
    for (const [key, value] of Object.entries(options.fields)) {
      body.set(key, value);
    }

    const action = element.getAttribute("action") || window.location.href;
    const url = new URL(action, window.location.href).toString();
    const response = await fetch(url, {
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`${response.status} for ${response.url}`);
    }

    return await response.text();
  }, { fields, submitFieldName });
}

export async function replaceDocumentHtml(
  scope: BrowserScope,
  html: string,
): Promise<void> {
  await scope.evaluate((nextHtml) => {
    document.open();
    document.write(nextHtml);
    document.close();
  }, html);
}
