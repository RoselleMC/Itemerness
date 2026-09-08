import {
    isAlias,
    isMap,
    isScalar,
    isSeq,
    parseAllDocuments,
    parseDocument,
    type Document,
    type Node,
    type Scalar,
} from "yaml";
import { MAX_LOCAL_YAML_BYTES } from "./saveLocalExport.js";

export type ConfigurationKind = "config" | "access";
export type ConfigurationPath = (string | number)[];
export interface LocalDiagnostic {
    path: string;
    code: string;
    warning?: boolean;
}
export interface LocalConfiguration {
    name: string;
    kind: ConfigurationKind;
    text: string;
    ast: Document;
    values: Map<string, unknown>;
    diagnostics: LocalDiagnostic[];
    editable: boolean;
}
export const API_ACTIONS = [
    "identify",
    "create",
    "read-data",
    "edit-data",
    "write-viewer-fact",
    "request-refresh",
] as const;
export const NAMED_COLORS = {
    black: "#000000",
    dark_blue: "#0000aa",
    dark_green: "#00aa00",
    dark_aqua: "#00aaaa",
    dark_red: "#aa0000",
    dark_purple: "#aa00aa",
    gold: "#ffaa00",
    gray: "#aaaaaa",
    dark_gray: "#555555",
    blue: "#5555ff",
    green: "#55ff55",
    aqua: "#55ffff",
    red: "#ff5555",
    light_purple: "#ff55ff",
    yellow: "#ffff55",
    white: "#ffffff",
} as const;
const namespace = (value: string) =>
    value.length >= 1 && value.length <= 64 && /^[a-z0-9_.-]+$/.test(value);
const itemKey = (value: string) =>
    value.length <= 256 &&
    /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value) &&
    namespace(value.split(":")[0]!);
const pathName = (path: ConfigurationPath) =>
    path.length
        ? path
              .map((part) => (typeof part === "number" ? `[${part}]` : part))
              .join(".")
              .replaceAll(".[", "[")
        : "$";
const kotlinTrim = (value: string) =>
    value.replace(
        /^[\p{Z}\t-\r\u001c-\u001f]+|[\p{Z}\t-\r\u001c-\u001f]+$/gu,
        "",
    );

// java.net.URI does not normalize origins: a trailing slash, user info and IDN hosts are invalid.
export function isJavaHttpOrigin(value: string): boolean {
    const match =
        /^(http|https):\/\/(\[[A-Za-z0-9:.%_-]+\]|[A-Za-z0-9.-]+)(?::([0-9]*))?$/.exec(
            value,
        );
    if (!match) return false;
    const host = match[2]!;
    if (match[3] && BigInt(match[3]) > 2147483647n) return false;
    if (host.startsWith("[")) {
        const scoped = /^\[([^%]+)(?:%([A-Za-z0-9_.]+))?\]$/.exec(host);
        if (!scoped) return false;
        let address = `[${scoped[1]}]`;
        const embedded = /:(\d+\.\d+\.\d+\.\d+)\]$/.exec(address);
        if (embedded) {
            const octets = embedded[1]!.split(".").map(Number);
            if (octets.some((octet) => octet > 255)) return false;
            address = address.replace(embedded[1]!, octets.join("."));
        }
        try {
            new URL(`http://${address}`);
            return address.includes(":");
        } catch {
            return false;
        }
    }
    const labels = host.replace(/\.$/, "").split(".");
    if (
        labels.some(
            (label) =>
                !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
        )
    )
        return false;
    if (labels.length > 1 && /^\d+$/.test(labels.at(-1)!))
        return (
            !host.endsWith(".") &&
            labels.length === 4 &&
            labels.every((label) => /^\d+$/.test(label) && Number(label) <= 255)
        );
    return true;
}

function validateValues(
    root: Map<string, unknown>,
    kind: ConfigurationKind,
): LocalDiagnostic[] {
    const issues: LocalDiagnostic[] = [];
    const report = (path: ConfigurationPath, code: string, warning = false) =>
        issues.push({
            path: pathName(path),
            code,
            ...(warning ? { warning } : {}),
        });
    const object = (
        value: unknown,
        path: ConfigurationPath,
        keys: readonly string[],
    ) => {
        if (!(value instanceof Map)) {
            report(path, "mapping");
            return new Map<string, unknown>();
        }
        if ([...value.keys()].some((key) => !keys.includes(String(key))))
            report(path, "unknownKey");
        return value as Map<string, unknown>;
    };
    const string = (
        value: unknown,
        path: ConfigurationPath,
        predicate?: (s: string) => boolean,
        code = "value",
    ) => {
        if (typeof value !== "string") {
            report(path, "string");
            return null;
        }
        if (predicate && !predicate(value)) report(path, code);
        return value;
    };
    const list = (
        value: unknown,
        path: ConfigurationPath,
        optional = false,
    ) => {
        if (value === undefined || value === null) {
            if (!optional) report(path, "list");
            return [];
        }
        if (!Array.isArray(value)) {
            report(path, "list");
            return [];
        }
        return value as unknown[];
    };
    const integer = (value: unknown, expected: bigint) =>
        typeof value === "bigint" && value === expected;
    if (kind === "config") {
        object(
            root,
            [],
            [
                "config-version",
                "catalog",
                "editor",
                "canonical-item",
                "locale",
                "presentation",
            ],
        );
        if (!integer(root.get("config-version"), 3n))
            report(["config-version"], "version");
        const catalog = object(
            root.get("catalog"),
            ["catalog"],
            ["default-namespace"],
        );
        string(
            catalog.get("default-namespace"),
            ["catalog", "default-namespace"],
            namespace,
            "namespace",
        );
        const editor = object(
            root.get("editor"),
            ["editor"],
            root.get("editor") instanceof Map &&
                (root.get("editor") as Map<string, unknown>).has("url")
                ? ["url", "token"]
                : ["enabled", "bind-host", "port", "token", "allowed-origins"],
        );
        if (editor.has("url")) {
            const url = string(editor.get("url"), ["editor", "url"]);
            const token = string(editor.get("token"), ["editor", "token"]);
            if (
                (url !== null && kotlinTrim(url)) ||
                (token !== null && kotlinTrim(token))
            )
                report(["editor"], "retired");
            else report(["editor"], "legacy", true);
        } else {
            const enabled = editor.get("enabled");
            if (typeof enabled !== "boolean")
                report(["editor", "enabled"], "boolean");
            string(
                editor.get("bind-host"),
                ["editor", "bind-host"],
                (v) => v.length <= 253 && /^[A-Za-z0-9.:-]+$/.test(v),
                "host",
            );
            const port = editor.get("port");
            if (typeof port !== "bigint" || port < 1024n || port > 65535n)
                report(["editor", "port"], "port");
            const token = string(editor.get("token"), ["editor", "token"]);
            if (enabled === true && token !== null) {
                const trimmed = kotlinTrim(token);
                if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(trimmed))
                    report(["editor", "token"], "environment", true);
                else if (!trimmed)
                    report(["editor", "token"], "unauthenticated", true);
                else if (!/^[A-Za-z0-9_~+/.=-]{32,256}$/.test(trimmed))
                    report(["editor", "token"], "token");
            }
            const origins = list(editor.get("allowed-origins"), [
                "editor",
                "allowed-origins",
            ]);
            if (origins.length > 16)
                report(["editor", "allowed-origins"], "originsLimit");
            origins.forEach((origin, i) =>
                string(
                    origin,
                    ["editor", "allowed-origins", i],
                    isJavaHttpOrigin,
                    "origin",
                ),
            );
        }
        const canonical = object(
            root.get("canonical-item"),
            ["canonical-item"],
            ["pending-name"],
        );
        const pending = object(
            canonical.get("pending-name"),
            ["canonical-item", "pending-name"],
            ["text", "color"],
        );
        string(
            pending.get("text"),
            ["canonical-item", "pending-name", "text"],
            (v) => v.split("{item-id}").length === 2,
            "template",
        );
        string(
            pending.get("color"),
            ["canonical-item", "pending-name", "color"],
            (v) => Object.hasOwn(NAMED_COLORS, v),
            "color",
        );
        const locale = object(root.get("locale"), ["locale"], ["default"]);
        string(
            locale.get("default"),
            ["locale", "default"],
            (v) => /^[a-z0-9]{2,16}(?:_[a-z0-9]{2,16})?$/.test(v),
            "locale",
        );
        const presentation = object(
            root.get("presentation"),
            ["presentation"],
            ["default-layout", "default-theme"],
        );
        for (const field of ["default-layout", "default-theme"])
            string(
                presentation.get(field),
                ["presentation", field],
                itemKey,
                "itemKey",
            );
    } else {
        object(root, [], ["config-version", "api"]);
        if (!integer(root.get("config-version"), 1n))
            report(["config-version"], "version");
        const api = object(root.get("api"), ["api"], ["defaults", "grants"]);
        const defaults = object(
            api.get("defaults"),
            ["api", "defaults"],
            API_ACTIONS,
        );
        for (const action of API_ACTIONS)
            string(
                defaults.get(action),
                ["api", "defaults", action],
                (v) =>
                    [
                        "allow",
                        "deny",
                        ...(action === "read-data" ? ["schema-policy"] : []),
                    ].includes(v),
                "decision",
            );
        list(api.get("grants"), ["api", "grants"]).forEach((value, i) => {
            const path: ConfigurationPath = ["api", "grants", i];
            const grant = object(value, path, [
                "plugin",
                "actions",
                "item-namespaces",
                "data-namespaces",
                "viewer-fact-namespaces",
            ]);
            string(
                grant.get("plugin"),
                [...path, "plugin"],
                (v) => v.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(v),
                "plugin",
            );
            const uniqueStrings = (
                key: string,
                optional: boolean,
                predicate: (s: string) => boolean,
                code: string,
            ) => {
                const values = list(grant.get(key), [...path, key], optional);
                values.forEach((v, index) =>
                    string(v, [...path, key, index], predicate, code),
                );
                if (new Set(values).size !== values.length)
                    report([...path, key], "duplicate");
                return values;
            };
            const actions = uniqueStrings(
                "actions",
                false,
                (v) => (API_ACTIONS as readonly string[]).includes(v),
                "action",
            );
            if (!actions.length) report([...path, "actions"], "required");
            for (const key of [
                "item-namespaces",
                "data-namespaces",
                "viewer-fact-namespaces",
            ]) {
                const values = uniqueStrings(key, true, namespace, "namespace");
                const required =
                    key === "item-namespaces"
                        ? actions.some((v) => v !== "write-viewer-fact")
                        : key === "data-namespaces"
                          ? actions.some(
                                (v) => v === "read-data" || v === "edit-data",
                            )
                          : actions.includes("write-viewer-fact");
                if (required && !values.length)
                    report([...path, key], "required");
            }
        });
    }
    return issues;
}

export function parseLocalConfiguration(
    name: string,
    text: string,
    expectedKind?: ConfigurationKind,
): LocalConfiguration {
    if (
        new TextEncoder().encode(text).byteLength > MAX_LOCAL_YAML_BYTES ||
        [...text].length > 1_000_000
    )
        throw new Error("FILE_SIZE_INVALID");
    const documents = parseAllDocuments(text, {
        version: "1.1",
        schema: "yaml-1.1",
        intAsBigInt: true,
        keepSourceTokens: true,
        prettyErrors: false,
        logLevel: "silent",
        uniqueKeys: true,
        strict: true,
    });
    const ast = documents[0] ?? parseDocument("", { logLevel: "silent" });
    const issues: LocalDiagnostic[] = [];
    let count = 0;
    function inspect(node: unknown, depth: number): void {
        if (++count > 100_000 || depth > 64) throw new Error("YAML_LIMIT");
        if (isAlias(node)) {
            if (!isScalar(node.resolve(ast))) throw new Error("YAML_ALIAS");
            return;
        }
        if (isMap(node)) {
            const keys = new Set<string>();
            for (const pair of node.items) {
                const key = isAlias(pair.key)
                    ? pair.key.resolve(ast)
                    : pair.key;
                if (!isScalar(key) || typeof key.value !== "string") {
                    if (!(
                        isScalar(key) &&
                        typeof key.value === "symbol" &&
                        key.value.description === "<<"
                    ))
                        throw new Error("YAML_KEY");
                } else {
                    if (keys.has(key.value)) throw new Error("YAML_SYNTAX");
                    keys.add(key.value);
                }
                inspect(pair.value, depth + 1);
            }
        } else if (isSeq(node))
            node.items.forEach((child) => inspect(child, depth + 1));
        else if (
            isScalar(node) &&
            node.value !== null &&
            !["string", "boolean", "number", "bigint"].includes(
                typeof node.value,
            )
        )
            throw new Error("YAML_VALUE");
    }
    let values = new Map<string, unknown>();
    try {
        if (
            documents.length !== 1 ||
            ast.errors.length ||
            ast.warnings.some(
                (warning) => warning.code === "TAG_RESOLVE_FAILED",
            )
        )
            throw new Error("YAML_SYNTAX");
        if (!isMap(ast.contents)) throw new Error("YAML_ROOT");
        inspect(ast.contents, 0);
        values = ast.toJS({ mapAsMap: true, maxAliasCount: 100_000 }) as Map<
            string,
            unknown
        >;
        function checkValues(value: unknown) {
            if (value instanceof Map) {
                value.forEach((child, key) => {
                    if (typeof key !== "string") throw new Error("YAML_KEY");
                    checkValues(child);
                });
            } else if (Array.isArray(value)) value.forEach(checkValues);
            else if (
                value !== null &&
                !["string", "boolean", "number", "bigint"].includes(
                    typeof value,
                )
            )
                throw new Error("YAML_VALUE");
        }
        checkValues(values);
        if (!(values instanceof Map)) throw new Error("YAML_ROOT");
    } catch (error) {
        const code =
            error instanceof Error && /^YAML_[A-Z_]+$/.test(error.message)
                ? error.message
                : "YAML_SYNTAX";
        issues.push({ path: "$", code });
    }
    const kind =
        expectedKind ??
        (values.has("api") || /(?:^|[\\/])access\.ya?ml$/i.test(name)
            ? "access"
            : "config");
    if (!issues.length) issues.push(...validateValues(values, kind));
    return {
        name,
        kind,
        text,
        ast,
        values,
        diagnostics: issues,
        editable: !issues.some(
            (issue) =>
                issue.code.startsWith("YAML_") || issue.code === "version",
        ),
    };
}

export function configurationValue(
    configuration: LocalConfiguration,
    path: ConfigurationPath,
): unknown {
    return path.reduce<unknown>(
        (value, key) =>
            value instanceof Map
                ? value.get(key)
                : Array.isArray(value) && typeof key === "number"
                  ? value[key]
                  : undefined,
        configuration.values,
    );
}

export function editLocalConfiguration(
    configuration: LocalConfiguration,
    path: ConfigurationPath,
    value: unknown,
    remove = false,
): LocalConfiguration {
    if (!configuration.editable) throw new Error("FILE_NOT_EDITABLE");
    const ast = configuration.ast.clone();
    const existing = ast.getIn(path, true);
    // Keep edits local to the selected field even when a scalar anchor is reused elsewhere.
    if (isScalar(existing) && existing.anchor) {
        const anchored = existing;
        const detached = () => {
            const copy = anchored.clone() as Scalar;
            delete copy.anchor;
            return copy;
        };
        function detach(node: unknown) {
            if (isMap(node))
                node.items.forEach((pair) => {
                    if (
                        isAlias(pair.value) &&
                        pair.value.resolve(ast) === anchored
                    )
                        pair.value = detached();
                    else detach(pair.value);
                });
            if (isSeq(node))
                node.items.forEach((child, index) => {
                    if (isAlias(child) && child.resolve(ast) === anchored)
                        node.items[index] = detached();
                    else detach(child);
                });
        }
        detach(ast.contents);
    }
    if (remove) ast.deleteIn(path);
    else if (
        isScalar(existing) &&
        (value === null || typeof value !== "object")
    ) {
        if (typeof existing.value !== typeof value) {
            delete existing.tag;
            delete existing.format;
        }
        existing.value = value;
    } else {
        const replacement = ast.createNode(value) as Node;
        if (isScalar(existing) || isMap(existing) || isSeq(existing)) {
            replacement.comment = existing.comment;
            replacement.commentBefore = existing.commentBefore;
        }
        ast.setIn(path, replacement);
    }
    return parseLocalConfiguration(
        configuration.name,
        ast.toString({ lineWidth: 0 }),
        configuration.kind,
    );
}

export function decodeLocalConfiguration(
    name: string,
    bytes: Uint8Array,
): LocalConfiguration {
    if (bytes.byteLength > MAX_LOCAL_YAML_BYTES)
        throw new Error("FILE_SIZE_INVALID");
    let text: string;
    try {
        text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(bytes);
    } catch {
        throw new Error("FILE_ENCODING_INVALID");
    }
    return parseLocalConfiguration(name, text);
}

export function numberInput(value: string): bigint | string {
    return /^[-+]?\d+$/.test(value) ? BigInt(value) : value;
}
