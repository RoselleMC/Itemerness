import {
    namespacedIdSchema,
    projectDocumentSchema,
    upgradeProjectDocument,
    type DataKeyIntegration,
    type DataKeyNode,
    type DataTypeNode,
    type ProjectDocument,
} from "@itemerness/protocol";

export type IntegrationIssue = { code: string; detail?: string };

/** Preserve a buffer committed by the same click before applying that click's policy change. */
export function mergeIntegrationEdit(
    current: DataKeyIntegration,
    previous: DataKeyIntegration,
    next: DataKeyIntegration,
): DataKeyIntegration {
    const mergeEntries = <T>(old: T[], changed: T[], latest: T[]) =>
        changed.map((entry) => {
            const index = old.indexOf(entry);
            return index >= 0 ? (latest[index] ?? entry) : entry;
        });
    return {
        readSources:
            next.readSources === previous.readSources
                ? current.readSources
                : mergeEntries(
                      previous.readSources,
                      next.readSources,
                      current.readSources,
                  ),
        access: {
            read:
                next.access.read === previous.access.read
                    ? current.access.read
                    : next.access.read,
            write:
                next.access.write === previous.access.write
                    ? current.access.write
                    : mergeEntries(
                          previous.access.write,
                          next.access.write,
                          current.access.write,
                      ),
        },
        placeholderApi: {
            exposed:
                next.placeholderApi.exposed === previous.placeholderApi.exposed
                    ? current.placeholderApi.exposed
                    : next.placeholderApi.exposed,
            formatter:
                next.placeholderApi.formatter ===
                previous.placeholderApi.formatter
                    ? current.placeholderApi.formatter
                    : next.placeholderApi.formatter,
        },
    };
}
export const isScalarKey = (key: DataKeyNode) =>
    !["list", "compound"].includes(key.type.kind);
export const primaryReadSource = (key: DataKeyNode) =>
    key.scope === "DEFINITION"
        ? ("catalogDefinition" as const)
        : ("canonicalNbt" as const);

export function emptyReviewPolicy(key: DataKeyNode): DataKeyIntegration {
    return {
        readSources: [{ kind: primaryReadSource(key) }],
        access: {
            read: "INTERNAL",
            write: key.scope === "DEFINITION" ? ["definition"] : [],
        },
        placeholderApi: { exposed: false, formatter: null },
    };
}

export function formatAcceptsType(
    document: ProjectDocument,
    id: string,
    type: DataTypeNode,
    seen = new Set<string>(),
): boolean {
    const format = document.formats.find((entry) => entry.id === id);
    if (!format || seen.has(id)) return false;
    const next = new Set(seen).add(id);
    switch (format.kind) {
        case "integer":
            return type.kind === "integer" || type.kind === "long";
        case "decimal":
            return ["integer", "long", "decimal"].includes(type.kind);
        case "boolean":
            return type.kind === "boolean";
        case "namespacedKey":
            return type.kind === "namespacedKey";
        case "list":
            return (
                type.kind === "list" &&
                formatAcceptsType(
                    document,
                    format.elementFormat,
                    type.element,
                    next,
                )
            );
    }
}

export function writerIssue(
    key: DataKeyNode,
    writer: string,
    others: string[],
): string | null {
    if (!/^(definition|internal|plugin:[A-Za-z0-9_.-]{1,64})$/.test(writer))
        return "writerSyntax";
    if (
        key.scope === "DEFINITION"
            ? writer !== "definition"
            : writer === "definition"
    )
        return "writerScope";
    return others.some((entry) => entry.toLowerCase() === writer.toLowerCase())
        ? "duplicateWriter"
        : null;
}

export function pdcCandidateIssue(
    document: ProjectDocument,
    key: DataKeyNode,
    policy: DataKeyIntegration,
    value: string,
    index?: number,
): string | null {
    if (!namespacedIdSchema.safeParse(value).success) return "pdcSyntax";
    if (key.scope !== "INSTANCE" || !isScalarKey(key)) return "pdcScope";
    if (
        policy.readSources.some(
            (source, position) =>
                position !== index &&
                source.kind === "pdc" &&
                source.key === value,
        )
    )
        return "duplicatePdc";
    const others = document.dataSchemas
        .flatMap((schema) => schema.keys)
        .filter((entry) => entry.uuid !== key.uuid);
    const count =
        others.reduce(
            (total, entry) =>
                total +
                (entry.integration?.readSources.filter(
                    (source) => source.kind === "pdc",
                ).length ?? 0),
            0,
        ) +
        policy.readSources.filter(
            (source, position) => source.kind === "pdc" && position !== index,
        ).length +
        1;
    if (count > 256) return "pdcBudget";
    if (
        others.some(
            (entry) =>
                entry.type.kind !== key.type.kind &&
                entry.integration?.readSources.some(
                    (source) => source.kind === "pdc" && source.key === value,
                ),
        )
    )
        return "pdcPhysicalType";
    return null;
}

export function integrationIssues(
    document: ProjectDocument,
    key: DataKeyNode,
    policy: DataKeyIntegration,
): IntegrationIssue[] {
    const issues: IntegrationIssue[] = [];
    if (policy.readSources[0]?.kind !== primaryReadSource(key))
        issues.push({ code: "primarySource" });
    policy.readSources.forEach((source, index) => {
        if (index > 0 && source.kind !== "pdc")
            issues.push({ code: "fallbackSource" });
        if (source.kind === "pdc") {
            const error = pdcCandidateIssue(
                document,
                key,
                policy,
                source.key,
                index,
            );
            if (error) issues.push({ code: error, detail: source.key });
        }
    });
    if (policy.access.read === "OWNER_ONLY")
        issues.push({ code: "ownerUnavailable" });
    if (!policy.access.write.length) issues.push({ code: "writerRequired" });
    policy.access.write.forEach((writer, index) => {
        const error = writerIssue(
            key,
            writer,
            policy.access.write.filter((_, position) => position !== index),
        );
        if (error) issues.push({ code: error, detail: writer });
    });
    if (
        policy.placeholderApi.exposed &&
        (policy.access.read !== "PUBLIC" || !isScalarKey(key))
    )
        issues.push({ code: "placeholderExposure" });
    if (
        policy.placeholderApi.formatter !== null &&
        !formatAcceptsType(document, policy.placeholderApi.formatter, key.type)
    )
        issues.push({
            code: "placeholderFormat",
            detail: policy.placeholderApi.formatter,
        });
    return [
        ...new Map(
            issues.map((issue) => [
                `${issue.code}:${issue.detail ?? ""}`,
                issue,
            ]),
        ).values(),
    ];
}

export type ReviewedPolicy = {
    policy: DataKeyIntegration;
    readChosen: boolean;
    confirmed: boolean;
};
export function upgradeWithReviewedPolicies(
    document: ProjectDocument,
    policies: Record<string, ReviewedPolicy>,
): ProjectDocument {
    for (const key of document.dataSchemas.flatMap((schema) => schema.keys)) {
        const entry = policies[key.uuid];
        if (!entry?.readChosen || !entry.confirmed)
            throw new Error("UNREVIEWED_POLICY");
    }
    const upgraded = upgradeProjectDocument(
        document,
        (_schema, key) => policies[key.uuid]!.policy,
    );
    for (const key of upgraded.dataSchemas.flatMap((schema) => schema.keys)) {
        if (integrationIssues(upgraded, key, key.integration!).length)
            throw new Error("INVALID_INTEGRATION_POLICY");
    }
    return projectDocumentSchema.parse(upgraded);
}
