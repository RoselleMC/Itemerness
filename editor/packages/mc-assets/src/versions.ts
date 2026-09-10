// Pinned client version.json resource-pack formats.
export const MINECRAFT_RESOURCE_FORMATS = {
    "1.21.11": { major: 75, minor: 0 },
    "26.1.1": { major: 84, minor: 0 },
    "26.1.2": { major: 84, minor: 0 },
    "26.2": { major: 88, minor: 0 },
} as const;

export type MinecraftClientVersion = keyof typeof MINECRAFT_RESOURCE_FORMATS;

export function isMinecraftClientVersion(
    value: string,
): value is MinecraftClientVersion {
    return Object.hasOwn(MINECRAFT_RESOURCE_FORMATS, value);
}
