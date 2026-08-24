import { describe, expect, it } from "vitest";
import {
    createRequestBoundary,
    rejectBoundaryRequest,
} from "../src/request-security.js";

describe("control-plane request boundary", () => {
    const boundary = createRequestBoundary("https://items.example.com", 8080);

    it("accepts the advertised origin and local loopback aliases", () => {
        expect(
            rejectBoundaryRequest(boundary, {
                host: "items.example.com",
                origin: "https://items.example.com",
                originPolicy: "required",
            }),
        ).toBeNull();
        for (const [host, origin] of [
            ["localhost:8080", "http://localhost:8080"],
            ["127.0.0.1:8080", "http://127.0.0.1:8080"],
            ["[::1]:8080", "http://[::1]:8080"],
        ]) {
            expect(
                rejectBoundaryRequest(boundary, {
                    host,
                    origin,
                    originPolicy: "required",
                }),
            ).toBeNull();
        }
    });

    it("rejects DNS-rebinding Host values before considering Origin", () => {
        expect(
            rejectBoundaryRequest(boundary, {
                host: "attacker.example",
                origin: "https://items.example.com",
                originPolicy: "if-present",
            }),
        ).toEqual({ statusCode: 421, error: "request host is not allowed" });
    });

    it("rejects cross-origin and alias-mismatched browser requests", () => {
        expect(
            rejectBoundaryRequest(boundary, {
                host: "items.example.com",
                origin: "https://attacker.example",
                originPolicy: "if-present",
            })?.statusCode,
        ).toBe(403);
        expect(
            rejectBoundaryRequest(boundary, {
                host: "127.0.0.1:8080",
                origin: "http://localhost:8080",
                originPolicy: "required",
            })?.statusCode,
        ).toBe(403);
    });

    it("requires Origin for browser WebSockets but permits non-browser REST and agents", () => {
        expect(
            rejectBoundaryRequest(boundary, {
                host: "items.example.com",
                origin: undefined,
                originPolicy: "required",
            })?.statusCode,
        ).toBe(403);
        expect(
            rejectBoundaryRequest(boundary, {
                host: "items.example.com",
                origin: undefined,
                originPolicy: "if-present",
            }),
        ).toBeNull();
        expect(
            rejectBoundaryRequest(boundary, {
                host: "items.example.com",
                origin: "https://attacker.example",
                originPolicy: "ignore",
            }),
        ).toBeNull();
    });

    it("rejects invalid advertised URLs", () => {
        expect(() =>
            createRequestBoundary("javascript:alert(1)", 8080),
        ).toThrow(/HTTP or HTTPS/u);
        expect(() =>
            createRequestBoundary("https://user@example.com", 8080),
        ).toThrow(/credentials/u);
    });
});
