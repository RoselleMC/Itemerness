import { z } from "zod";
import { projectDocumentSchema } from "./document.js";
import { diagnosticSchema } from "./diagnostics.js";

export const catalogReadSchema = z.strictObject({
    document: projectDocumentSchema,
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    diagnostics: z.array(diagnosticSchema).max(4096),
});
export type CatalogRead = z.infer<typeof catalogReadSchema>;

/** The fingerprint of the server's YAML now; it equals a draft's import baseline while the YAML is unchanged. */
export const catalogStatusSchema = z.strictObject({
    serverId: z.string().min(1).max(128),
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type CatalogStatus = z.infer<typeof catalogStatusSchema>;

const domainPath = z
    .string()
    .max(512)
    .regex(
        /^(data-keys|items|formats|locales|layouts|themes|viewer-facts|assets)\/[a-zA-Z0-9_./-]+\.ya?ml$/,
    )
    .refine(
        (path) =>
            path
                .split("/")
                .every((part) => part !== "" && part !== "." && part !== ".."),
        "Unsafe catalog file path",
    );
export const catalogExportSchema = z
    .strictObject({
        files: z
            .array(
                z.strictObject({
                    path: domainPath,
                    content: z.string().max(2 * 1024 * 1024),
                }),
            )
            .max(4096),
        settingsPatch: z.string().max(65536),
        diagnostics: z.array(diagnosticSchema).max(4096),
    })
    .superRefine((result, context) => {
        const paths = new Set<string>();
        result.files.forEach((file, index) => {
            const path = file.path.toLowerCase();
            if (paths.has(path))
                context.addIssue({
                    code: "custom",
                    path: ["files", index, "path"],
                    message: "Duplicate catalog file path",
                });
            paths.add(path);
        });
    });
export type CatalogExport = z.infer<typeof catalogExportSchema>;
