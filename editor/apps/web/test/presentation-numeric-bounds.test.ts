import { describe, expect, it } from "vitest";
import { numericThemeError } from "../src/features/inspector/themeEditing.js";
import { layoutNumberError } from "../src/features/inspector/layoutEditing.js";
import {
    SOURCE_INT_MIN,
    SOURCE_INT_MAX,
} from "../src/features/inspector/presentationNumbers.js";

describe("presentation source integer fields", () => {
    it("accepts the full source Int range and rejects overflow or unfinished input", () => {
        for (const value of [
            SOURCE_INT_MIN,
            -4097,
            -1,
            0,
            1025,
            SOURCE_INT_MAX,
        ]) {
            expect(
                numericThemeError(
                    String(value),
                    SOURCE_INT_MIN,
                    SOURCE_INT_MAX,
                ),
            ).toBe(false);
            expect(
                layoutNumberError(
                    String(value),
                    SOURCE_INT_MIN,
                    SOURCE_INT_MAX,
                ),
            ).toBeNull();
        }
        for (const raw of [
            "-",
            "",
            "1.5",
            String(SOURCE_INT_MIN - 1),
            String(SOURCE_INT_MAX + 1),
        ]) {
            expect(numericThemeError(raw, SOURCE_INT_MIN, SOURCE_INT_MAX)).toBe(
                true,
            );
            expect(layoutNumberError(raw, SOURCE_INT_MIN, SOURCE_INT_MAX)).toBe(
                "integerRange",
            );
        }
    });

    it("retains real nonnegative, line-step and document width or height constraints", () => {
        expect(
            layoutNumberError("2147483640", 0, SOURCE_INT_MAX, 10),
        ).toBeNull();
        expect(layoutNumberError("2147483641", 0, SOURCE_INT_MAX, 10)).toBe(
            "step",
        );
        expect(layoutNumberError("-10", 0, SOURCE_INT_MAX, 10)).toBe(
            "integerRange",
        );
        expect(layoutNumberError("1500", 0, 1999)).toBeNull();
        expect(layoutNumberError("2000", 0, 1999)).toBe("integerRange");
        expect(layoutNumberError("300", 1, 4096)).toBeNull();
        expect(layoutNumberError("4097", 1, 4096)).toBe("integerRange");
        expect(numericThemeError("9", 0, 8)).toBe(true);
    });
});
