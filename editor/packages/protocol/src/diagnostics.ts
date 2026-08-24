import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * Diagnostics never carry rendered prose.
 *
 * A diagnostic that arrived as an English sentence could not be shown to a Chinese editor, and
 * the control plane has no business deciding the reader's language. Every producer emits a stable
 * `code`, a `messageKey`, and typed `params`; the browser renders the sentence through its own
 * i18n catalog. This is the single rule that makes the whole product translatable.
 */

export const diagnosticSeveritySchema = z.enum(["ERROR", "WARNING", "INFO"]);
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;

export const diagnosticOriginSchema = z.enum([
    "browser",
    "control-plane",
    "agent",
]);
export type DiagnosticOrigin = z.infer<typeof diagnosticOriginSchema>;

export const diagnosticParamSchema = z.union([
    z.string().max(2_048),
    z.number(),
    z.boolean(),
]);

export const diagnosticSchema = z.object({
    /** Stable machine code, e.g. `PRESENTATION.MISSING_REFERENCE`. Safe to branch on. */
    code: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/),
    severity: diagnosticSeveritySchema,
    origin: diagnosticOriginSchema,
    /** i18n key resolved by the browser. Conventionally `diagnostics.<lower.dotted.code>`. */
    messageKey: z.string().min(1).max(256),
    params: z.record(z.string().max(64), diagnosticParamSchema).default({}),
    /** RFC 6901 pointer into the project document, when the problem has a document location. */
    pointer: z.string().max(1_024).nullable().default(null),
    /** Stable node identity, which survives reordering in a way a pointer does not. */
    nodeUuid: uuidSchema.nullable().default(null),
    /** Business id such as `itemerness:ember-blade`, for display and search. */
    businessId: z.string().max(256).nullable().default(null),
    /** Which target produced this, when capabilities differ across servers. */
    targetServerId: z.string().max(128).nullable().default(null),
    /** Optional remediation hint, also an i18n key. */
    fixKey: z.string().max(256).nullable().default(null),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export function hasBlockingDiagnostics(
    diagnostics: readonly Diagnostic[],
): boolean {
    return diagnostics.some((diagnostic) => diagnostic.severity === "ERROR");
}
