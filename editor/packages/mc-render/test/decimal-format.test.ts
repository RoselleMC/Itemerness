import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    formatDefaultDecimal,
    formatJavaNumber,
    LocalFormatError,
} from "../src/decimalFormat.js";

const cases = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/decimal-format-cases.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Array<{
    name: string;
    kind: "integer" | "decimal";
    value: string;
    pattern: string;
    locale: string;
    multiply?: number;
}>;
const golden = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/decimal-format-golden.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Record<string, { text?: string; error?: string; default: string }>;
cases.push(
    ...(JSON.parse(
        readFileSync(
            new URL(
                "../../protocol/fixtures/decimal-format-generated-cases.json",
                import.meta.url,
            ),
            "utf8",
        ),
    ) as typeof cases),
);

describe("Java DecimalFormat parity", () => {
    it.each(cases)(
        "matches the production value formatter: $name",
        (fixture) => {
            const format = () =>
                formatJavaNumber(
                    fixture.value,
                    fixture.kind,
                    fixture.pattern,
                    fixture.locale,
                    fixture.multiply,
                );
            if (golden[fixture.name]!.error)
                expect(format).toThrow(LocalFormatError);
            else expect(format()).toBe(golden[fixture.name]!.text);
        },
    );
    it.each(cases.filter((fixture) => fixture.kind === "decimal"))(
        "matches the default decimal representation: $name",
        (fixture) =>
            expect(formatDefaultDecimal(fixture.value)).toBe(
                golden[fixture.name]!.default,
            ),
    );
});
