import { parseTokens } from "@messageformat/number-skeleton/lib/pattern-parser/parse-tokens.js";
import type { AffixToken } from "@messageformat/number-skeleton/lib/pattern-parser/affix-tokens.js";
import type { NumberToken } from "@messageformat/number-skeleton/lib/pattern-parser/number-tokens.js";
import Decimal from "decimal.js";
import symbolData from "./data/java-decimal-symbols-25.json";

export class LocalFormatError extends Error {
    constructor(
        message: string,
        readonly unsupported = false,
    ) {
        super(message);
        this.name = "LocalFormatError";
    }
}

const Exact = Decimal.clone({
    precision: 1100,
    rounding: Decimal.ROUND_HALF_UP,
});
const languageIndexes = new Map(
    symbolData.languages.map((id, index) => [id, index]),
);
const regionIndexes = new Map(
    symbolData.regions.map((id, index) => [id, index]),
);

interface Pattern {
    prefix: AffixToken[];
    suffix: AffixToken[];
    negative?: { prefix: AffixToken[]; suffix: AffixToken[] };
    minimumInteger: number;
    maximumInteger: number;
    minimumFraction: number;
    maximumFraction: number;
    groupSize: number;
    decimalAlways: boolean;
    exponentDigits: number;
    multiplier: number;
    currency: boolean;
}

function javaLiterals(pattern: string): {
    source: string;
    currencyWidths: number[];
} {
    let quoted = false;
    let prefix = "";
    let suffix = "";
    let number = "";
    let exponent = "";
    let literal = "";
    const parts: string[] = [];
    const currencyWidths: number[] = [];
    const append = (value: string) => {
        if (number) suffix += value;
        else prefix += value;
    };
    const flush = () => {
        if (literal)
            append(
                /^'+$/.test(literal)
                    ? literal.replaceAll("'", "''")
                    : `'${literal.replaceAll("'", "''")}'`,
            );
        literal = "";
    };
    const finish = () => {
        flush();
        if (parts.length === 0 && !prefix && !number && !suffix)
            throw new LocalFormatError(
                "Decimal pattern has no positive subpattern",
            );
        parts.push(prefix + number + exponent + suffix);
        prefix = suffix = number = exponent = "";
    };
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index]!;
        if (char === "'") {
            if (pattern[index + 1] === "'") {
                literal += "'";
                index += 1;
            } else quoted = !quoted;
        } else if (quoted) literal += char;
        else if (char === ";") {
            finish();
            if (parts.length > 1)
                throw new LocalFormatError("Too many decimal subpatterns");
        } else if (/[#0.,]/.test(char)) {
            flush();
            number += char;
        } else if (char === "E" && number && !exponent && !suffix && !literal) {
            if (pattern[index + 1] !== "0")
                throw new LocalFormatError("Malformed decimal exponent");
            exponent = "E";
            while (pattern[index + 1] === "0") {
                index += 1;
                exponent += "0";
            }
        } else if (/[+%\u2030\u00a4-]/.test(char)) {
            flush();
            if (char === "\u00a4") {
                let width = 1;
                while (pattern[index + 1] === char) {
                    index += 1;
                    width += 1;
                }
                currencyWidths.push(width);
            }
            append(char);
        } else literal += char;
    }
    if (quoted)
        throw new LocalFormatError(
            "Unterminated quoted literal in decimal pattern",
        );
    finish();
    return { source: parts.join(";"), currencyWidths };
}

function numericPattern(tokens: NumberToken[]) {
    let minimumInteger = 0;
    let maximumInteger = 0;
    let minimumFraction = 0;
    let maximumFraction = 0;
    let decimal = false;
    let groupStart = -1;
    let exponentDigits = 0;
    for (const token of tokens) {
        if (exponentDigits > 0)
            throw new LocalFormatError(
                "Unexpected token after decimal exponent",
            );
        switch (token.char) {
            case "0":
                if (decimal) {
                    if (maximumFraction > minimumFraction)
                        throw new LocalFormatError(
                            "Required fractional digits follow optional digits",
                        );
                    minimumFraction += token.width;
                    maximumFraction += token.width;
                } else {
                    minimumInteger += token.width;
                    maximumInteger += token.width;
                }
                break;
            case "#":
                if (decimal) maximumFraction += token.width;
                else {
                    if (minimumInteger > 0)
                        throw new LocalFormatError(
                            "Optional integer digits follow required digits",
                        );
                    maximumInteger += token.width;
                }
                break;
            case ".":
                if (decimal)
                    throw new LocalFormatError(
                        "Multiple decimal separators in pattern",
                    );
                decimal = true;
                break;
            case ",":
                if (decimal)
                    throw new LocalFormatError(
                        "Grouping separator appears after decimal separator",
                    );
                groupStart = maximumInteger;
                break;
            case "E":
                if (token.plus)
                    throw new LocalFormatError(
                        "Java decimal patterns do not accept an exponent plus sign",
                    );
                exponentDigits = token.expDigits;
                break;
            default:
                throw new LocalFormatError(
                    "Unsupported Java decimal pattern token",
                    true,
                );
        }
    }
    if (groupStart === maximumInteger)
        throw new LocalFormatError("Decimal pattern has no complete number");
    if (tokens.length === 0) {
        minimumInteger = 1;
        maximumInteger = 1;
    }
    if (exponentDigits > 0 && maximumInteger + maximumFraction === 0)
        throw new LocalFormatError(
            "Scientific pattern requires numeric placeholders",
        );
    if (
        minimumInteger === 0 &&
        minimumFraction === 0 &&
        (exponentDigits === 0 || decimal)
    ) {
        if (maximumInteger > 0) minimumInteger = 1;
        else if (maximumFraction > 0 && exponentDigits === 0)
            minimumFraction = 1;
        else if (exponentDigits === 0) minimumInteger = 1;
    }
    return {
        minimumInteger,
        maximumInteger,
        minimumFraction,
        maximumFraction,
        groupSize: groupStart < 0 ? 0 : maximumInteger - groupStart,
        decimalAlways:
            (decimal && maximumFraction === 0) || maximumInteger === 0,
        exponentDigits,
    };
}

const patterns = new Map<string, Pattern>();
function parsePattern(pattern: string): Pattern {
    const cached = patterns.get(pattern);
    if (cached) return cached;
    // DecimalFormat treats an empty pattern as its unlimited, grouped default.
    if (pattern === "") {
        return {
            prefix: [],
            suffix: [],
            minimumInteger: 0,
            maximumInteger: 2147483647,
            minimumFraction: 0,
            maximumFraction: 2147483647,
            groupSize: 3,
            decimalAlways: false,
            exponentDigits: 0,
            multiplier: 1,
            currency: false,
        };
    }
    let parsed: ReturnType<typeof parseTokens>;
    try {
        const normalized = javaLiterals(pattern);
        parsed = parseTokens(normalized.source, (error) => {
            throw error;
        });
        const subpatterns = [
            parsed.tokens,
            ...(parsed.negative ? [parsed.negative] : []),
        ];
        let currencyIndex = 0;
        for (const part of subpatterns) {
            for (const tokens of [part.prefix, part.suffix]) {
                for (const token of tokens)
                    if (token.char === "\u00a4")
                        token.width =
                            normalized.currencyWidths[currencyIndex++]!;
            }
            if (part.number.length === 0) {
                part.prefix.push(...part.suffix);
                part.suffix = [];
            }
            if (
                [...part.prefix, ...part.suffix].filter(
                    (token) => token.char === "%",
                ).length > 1
            )
                throw new LocalFormatError(
                    "Multiple percent or per-mille symbols in decimal pattern",
                );
        }
    } catch (error) {
        if (error instanceof LocalFormatError) throw error;
        throw new LocalFormatError(
            error instanceof Error ? error.message : "Invalid decimal pattern",
        );
    }
    const values = numericPattern(parsed.tokens.number);
    if (parsed.negative) numericPattern(parsed.negative.number);
    const affixes = [...parsed.tokens.prefix, ...parsed.tokens.suffix];
    const percent = affixes.filter((token) => token.char === "%");
    if (percent.length > 1)
        throw new LocalFormatError(
            "Multiple percent or per-mille symbols in decimal pattern",
        );
    const result: Pattern = {
        ...values,
        prefix: parsed.tokens.prefix,
        suffix: parsed.tokens.suffix,
        negative: parsed.negative,
        multiplier:
            percent[0]?.style === "percent"
                ? 100
                : percent[0]?.style === "permille"
                  ? 1000
                  : 1,
        currency: [
            ...affixes,
            ...(parsed.negative
                ? [...parsed.negative.prefix, ...parsed.negative.suffix]
                : []),
        ].some((token) => token.char === "\u00a4"),
    };
    if (patterns.size >= 256) patterns.delete(patterns.keys().next().value!);
    patterns.set(pattern, result);
    return result;
}

function symbolsFor(locale: string) {
    const [language = "", region = ""] = locale.split("_");
    const variant = (symbolData.variants as Record<string, number>)[
        locale.replaceAll("_", "-")
    ];
    const combination =
        symbolData.combinations[
            variant ??
                symbolData.rows[languageIndexes.get(language) ?? 0]![
                    regionIndexes.get(region.toUpperCase()) ?? 0
                ]!
        ]!;
    return {
        ...symbolData.symbols[combination[0]!]!,
        currency: symbolData.currencies[combination[1]!]!,
        internationalCurrency: symbolData.currencies[combination[2]!]!,
    };
}
type Symbols = ReturnType<typeof symbolsFor>;

function affix(tokens: AffixToken[], symbols: Symbols): string {
    return tokens
        .map((token) => {
            switch (token.char) {
                case "'":
                    return token.str;
                case "-":
                    return symbols.minus;
                case "+":
                    return "+";
                case "%":
                    return token.style === "percent"
                        ? symbols.percent
                        : symbols.permille;
                case "\u00a4":
                    return (
                        symbols.internationalCurrency.repeat(
                            Math.floor(token.width / 2),
                        ) + (token.width % 2 ? symbols.currency : "")
                    );
                default:
                    throw new LocalFormatError(
                        "Unsupported decimal affix",
                        true,
                    );
            }
        })
        .join("");
}

function exactDouble(value: number): Decimal {
    if (value === 0) return new Exact(value);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Math.abs(value));
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const significand =
        (bits & 0xfffffffffffffn) + (exponent === 0 ? 0n : 0x10000000000000n);
    return new Exact(significand.toString()).mul(
        new Exact(2).pow((exponent === 0 ? -1022 : exponent - 1023) - 52),
    );
}

function shortestDouble(value: number): Decimal {
    const absolute = Math.abs(value);
    const shortest = new Exact(absolute.toString());
    return shortest.sd() === 1
        ? exactDouble(value).toSignificantDigits(2, Decimal.ROUND_HALF_EVEN)
        : shortest;
}

function legacyDecimalDigits(value: number, exact: Decimal): Decimal {
    if (exact.isZero()) return exact;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Math.abs(value));
    const bits = view.getBigUint64(0);
    const storedExponent = Number(bits >> 52n);
    const mantissa =
        (bits & 0xfffffffffffffn) + (storedExponent ? 0x10000000000000n : 0n);
    const binaryDigits = mantissa.toString(2);
    const significantBits = binaryDigits.length;
    const fractionBits = binaryDigits.replace(/0+$/, "").length;
    const binaryExponent = storedExponent
        ? storedExponent - 1023
        : significantBits - 1075;

    // DecimalFormat retains Java's older digit interval and integer fast-path semantics.
    if (binaryExponent <= 62 && binaryExponent >= -21 && exact.isInteger()) {
        const discarded =
            binaryExponent > significantBits
                ? Math.floor(
                      (binaryExponent - significantBits - 1) *
                          Math.LOG10E *
                          Math.LN2,
                  )
                : 0;
        const unit = new Exact(10).pow(discarded);
        return exact.div(unit).toDecimalPlaces(0).mul(unit);
    }
    const normalized = Number(mantissa) / 2 ** (significantBits - 1);
    const initialExponent = Math.floor(
        (normalized - 1.5) * 0.289529654 +
            0.176091259 +
            binaryExponent * 0.301029995663981,
    );
    const radius = new Exact(2).pow(
        binaryExponent - significantBits - (fractionBits === 1 ? 1 : 0),
    );
    const tinyBits = Math.max(0, fractionBits - binaryExponent - 1);
    const numeratorFives = Math.max(0, -initialExponent);
    const denominatorFives = Math.max(0, initialExponent);
    let numeratorTwos =
        numeratorFives + tinyBits + binaryExponent - fractionBits + 1;
    let denominatorTwos = denominatorFives + tinyBits;
    const common = Math.min(numeratorTwos, denominatorTwos);
    numeratorTwos -= common;
    denominatorTwos -= common;
    const radiusTwos =
        numeratorFives +
        tinyBits +
        binaryExponent -
        significantBits -
        common -
        (fractionBits === 1 ? 1 : 0);
    if (radiusTwos < 0) {
        numeratorTwos -= radiusTwos;
        denominatorTwos -= radiusTwos;
    }
    const fiveBits = (power: number) =>
        power < 27 ? Math.ceil(power * Math.log2(5)) : power * 3;
    const inclusiveUpper =
        fractionBits + numeratorTwos + fiveBits(numeratorFives) >= 64 ||
        denominatorTwos + 1 + fiveBits(denominatorFives + 1) >= 64;
    const firstUnit = new Exact(10).pow(initialExponent);
    const firstUpper = exact.div(firstUnit).ceil().mul(firstUnit);
    const correctedExponent =
        exact.lt(firstUnit) &&
        (inclusiveUpper
            ? firstUpper.minus(exact).gt(radius)
            : firstUpper.minus(exact).gte(radius))
            ? initialExponent - 1
            : initialExponent;
    const minimumPasses =
        correctedExponent < -3 || correctedExponent >= 8 ? 2 : 1;

    // Search adjacent decimal grid points inside the binary rounding interval.
    for (let pass = 1; pass <= 20; pass += 1) {
        const unit = new Exact(10).pow(initialExponent - pass + 1);
        const lower = exact.div(unit).floor().mul(unit);
        const upper = lower.plus(unit);
        const below = exact.minus(lower);
        const above = upper.minus(exact);
        const acceptsLower = below.lt(radius);
        const acceptsUpper = inclusiveUpper
            ? above.lte(radius)
            : above.lt(radius);
        if (pass < minimumPasses || (!acceptsLower && !acceptsUpper)) continue;
        if (!acceptsUpper) return lower;
        if (!acceptsLower) return upper;
        return exact
            .div(unit)
            .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
            .mul(unit);
    }
    throw new LocalFormatError(
        "Java decimal digit conversion exceeded its precision bound",
        true,
    );
}

function localizedDigits(value: string, symbols: Symbols): string {
    const zero = symbols.zero.codePointAt(0)!;
    return value.replace(/[0-9]/g, (digit) =>
        String.fromCodePoint(zero + Number(digit)),
    );
}

function fixedNumber(
    value: Decimal,
    minimumInteger: number,
    minimumFraction: number,
    maximumFraction: number,
    groupSize: number,
    decimalAlways: boolean,
    symbols: Symbols,
    monetary: boolean,
): string {
    const parts = value
        .toFixed(
            Math.min(maximumFraction, Math.max(minimumFraction, value.dp())),
        )
        .split(".");
    let integer = parts[0]!;
    let fraction = parts[1] ?? "";
    while (fraction.length > minimumFraction && fraction.endsWith("0"))
        fraction = fraction.slice(0, -1);
    if (integer === "0" && minimumInteger === 0) integer = "";
    if (!integer && !fraction && !decimalAlways) integer = "0";
    integer = integer.padStart(minimumInteger, "0");
    if (groupSize > 0) {
        const groups: string[] = [];
        while (integer.length > groupSize) {
            groups.unshift(integer.slice(-groupSize));
            integer = integer.slice(0, -groupSize);
        }
        groups.unshift(integer);
        integer = groups.join(monetary ? symbols.monetaryGroup : symbols.group);
    }
    return localizedDigits(
        integer +
            (fraction.length > 0 || decimalAlways
                ? (monetary ? symbols.monetaryDecimal : symbols.decimal) +
                  fraction
                : ""),
        symbols,
    );
}

/** Numeric semantics of Java DecimalFormat with HALF_UP, not Intl's decimal rounding. */
export function formatJavaNumber(
    value: string,
    kind: "integer" | "decimal",
    pattern: string,
    locale: string,
    multiply = 1,
): string {
    const parsed = parsePattern(pattern);
    const symbols = symbolsFor(locale);
    let exact: Decimal;
    let shortest: Decimal;
    let negative: boolean;
    let infinite = false;
    if (kind === "integer") {
        const integer = BigInt(value);
        if (integer < -9223372036854775808n || integer > 9223372036854775807n)
            throw new LocalFormatError("Integer is outside the Long range");
        negative = integer < 0n;
        exact = new Exact((integer < 0n ? -integer : integer).toString()).mul(
            parsed.multiplier,
        );
        shortest = exact;
    } else {
        const scaled = Number(value) * multiply;
        if (!Number.isFinite(scaled))
            throw new LocalFormatError(
                "Decimal formatter produced a non-finite number",
            );
        const number = scaled * parsed.multiplier;
        negative = number < 0 || Object.is(number, -0);
        infinite = !Number.isFinite(number);
        exact = infinite ? new Exact(0) : exactDouble(number);
        shortest = infinite ? exact : legacyDecimalDigits(number, exact);
    }
    let output: string;
    if (infinite) output = symbols.infinity;
    else if (parsed.exponentDigits > 0) {
        const maxInteger = Math.max(1, parsed.maximumInteger);
        const minInteger = parsed.minimumInteger;
        const significant = Math.max(
            1,
            parsed.maximumInteger + parsed.maximumFraction,
        );
        const rounded =
            shortest.sd() <= significant
                ? shortest
                : exact.toSignificantDigits(significant);
        const engineering = maxInteger > minInteger && maxInteger > 1;
        const exponent = rounded.isZero()
            ? 0
            : engineering
              ? Math.floor(rounded.e / maxInteger) * maxInteger
              : rounded.e - minInteger + 1;
        const mantissa = rounded.div(new Exact(10).pow(exponent));
        const integerDigits = Math.max(
            engineering ? 1 : minInteger,
            mantissa.isZero() ? 0 : mantissa.e + 1,
        );
        const minimumFraction = Math.max(
            0,
            parsed.minimumInteger + parsed.minimumFraction - integerDigits,
        );
        const maximumFraction = Math.max(
            minimumFraction,
            significant - integerDigits,
        );
        output = fixedNumber(
            mantissa,
            engineering ? 1 : minInteger,
            minimumFraction,
            maximumFraction,
            0,
            parsed.decimalAlways,
            symbols,
            parsed.currency,
        );
        output +=
            symbols.exponent +
            (exponent < 0 ? symbols.minus : "") +
            localizedDigits(
                Math.abs(exponent)
                    .toString()
                    .padStart(parsed.exponentDigits, "0"),
                symbols,
            );
    } else {
        const rounded =
            shortest.dp() <= parsed.maximumFraction
                ? shortest
                : exact.toDecimalPlaces(parsed.maximumFraction);
        output = fixedNumber(
            rounded,
            parsed.minimumInteger,
            parsed.minimumFraction,
            parsed.maximumFraction,
            parsed.groupSize,
            parsed.decimalAlways,
            symbols,
            parsed.currency,
        );
    }
    const positivePrefix = affix(parsed.prefix, symbols);
    const positiveSuffix = affix(parsed.suffix, symbols);
    if (!negative) return positivePrefix + output + positiveSuffix;
    const negativePrefix = parsed.negative
        ? affix(parsed.negative.prefix, symbols)
        : symbols.minus + positivePrefix;
    const negativeSuffix = parsed.negative
        ? affix(parsed.negative.suffix, symbols)
        : positiveSuffix;
    return negativePrefix === positivePrefix &&
        negativeSuffix === positiveSuffix
        ? symbols.minus + positivePrefix + output + positiveSuffix
        : negativePrefix + output + negativeSuffix;
}

export function formatDefaultDecimal(value: string): string {
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new LocalFormatError("Decimal data must be finite");
    if (number === 0) return "0";
    return (number < 0 ? "-" : "") + shortestDouble(number).toFixed();
}
