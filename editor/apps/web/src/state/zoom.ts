export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 32;
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
export function canvasGutter(viewport: {
    width: number;
    height: number;
}): number {
    return Math.max(
        16,
        Math.min(48, Math.min(viewport.width, viewport.height) / 8),
    );
}
export function smoothZoomStep(
    current: number,
    target: number,
    elapsed: number,
): number {
    const next =
        current +
        (target - current) *
            (1 - Math.exp(-Math.min(64, Math.max(0, elapsed)) / 45));
    return Math.abs(next - target) < Math.max(0.0001, target * 0.0005)
        ? target
        : next;
}
export function clampZoom(value: number): number {
    return Number.isFinite(value)
        ? Math.max(
              MIN_ZOOM,
              Math.min(MAX_ZOOM, Math.round(value * 10000) / 10000),
          )
        : 1;
}
export function wheelZoom(current: number, delta: number): number {
    return clampZoom(
        current * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.0025),
    );
}
export function fitZoom(
    viewport: { width: number; height: number },
    items: readonly { width: number; height: number }[],
    padding = 24,
    gap = 32,
): number {
    if (
        !items.length ||
        viewport.width <= padding * 2 ||
        viewport.height <= padding * 2
    )
        return 1;
    const width = items.reduce((total, item) => total + item.width, 0);
    const height = Math.max(...items.map((item) => item.height));
    return clampZoom(
        Math.floor(
            Math.min(
                (viewport.width - padding * 2 - gap * (items.length - 1)) /
                    Math.max(1, width),
                (viewport.height - padding * 2) / Math.max(1, height),
            ) * 10000,
        ) / 10000,
    );
}
