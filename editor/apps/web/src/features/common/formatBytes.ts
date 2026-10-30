/** Two decimals, so a document just over a limit does not read as equal to it. */
export function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
        : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
