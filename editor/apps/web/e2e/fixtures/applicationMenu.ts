import type { Page } from "@playwright/test";

export async function applicationMenuAction(
    page: Page,
    group: string,
    command: string,
) {
    // Clear the text target so global document commands do not use input history.
    await page.getByTestId("toggle-navigation").focus();
    const trigger = page.getByTestId(`app-menu-${group}`);
    if (await trigger.isVisible()) await trigger.click();
    else {
        await page.getByTestId("app-menu-compact").click();
        await page.getByTestId(`menu-application-${group}`).hover();
    }
    await page.getByTestId(`menu-${command}`).click();
}
