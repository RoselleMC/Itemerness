interface Defaults {
    defaultLayout?: string | null;
    defaultTheme?: string | null;
}
interface ItemPresentation {
    presentation: { layout?: string | null; theme?: string | null };
}

export function itemLayout(
    document: Defaults,
    item: ItemPresentation,
): string | null {
    return item.presentation.layout ?? document.defaultLayout ?? null;
}

export function itemTheme(
    document: Defaults,
    item: ItemPresentation,
): string | null {
    return item.presentation.theme ?? document.defaultTheme ?? null;
}
