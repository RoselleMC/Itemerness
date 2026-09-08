import { namespacedIdSchema } from "@itemerness/protocol";

/** Reserve room for collision suffixes without changing the namespace. */
export function freshNamespacedId(
    base: string,
    used: ReadonlySet<string>,
): string {
    const separator = base.indexOf(":");
    const namespace = base.slice(0, separator);
    const path = base.slice(separator + 1);
    for (let count = 1; ; count++) {
        const suffix = count === 1 ? "" : `-${count}`;
        const candidate = namespacedIdSchema.parse(
            `${namespace}:${path.slice(0, 255 - namespace.length - suffix.length)}${suffix}`,
        );
        if (!used.has(candidate)) return candidate;
    }
}
