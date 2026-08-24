export interface RequestBoundary {
    readonly allowedHosts: ReadonlySet<string>;
    readonly allowedOrigins: ReadonlySet<string>;
}

export type OriginPolicy = "ignore" | "if-present" | "required";

export interface BoundaryRejection {
    readonly statusCode: 403 | 421;
    readonly error: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

function parseHttpOrigin(value: string, label: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${label} must be an absolute HTTP(S) URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${label} must use HTTP or HTTPS`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`${label} must not contain credentials`);
    }
    return parsed;
}

function normalizedHost(value: string | undefined): string | null {
    if (!value || /[\s,\\/]/u.test(value)) return null;
    try {
        const parsed = new URL(`http://${value}`);
        if (parsed.pathname !== "/" || parsed.search || parsed.hash)
            return null;
        return parsed.host.toLowerCase();
    } catch {
        return null;
    }
}

/** Builds the exact browser boundary from the advertised public URL and listening port. */
export function createRequestBoundary(
    publicBaseUrl: string,
    listeningPort: number,
): RequestBoundary {
    if (
        !Number.isInteger(listeningPort) ||
        listeningPort < 1 ||
        listeningPort > 65_535
    ) {
        throw new Error("listeningPort must be between 1 and 65535");
    }
    const advertised = parseHttpOrigin(publicBaseUrl, "PUBLIC_BASE_URL");
    const allowedHosts = new Set<string>([advertised.host.toLowerCase()]);
    const allowedOrigins = new Set<string>([advertised.origin.toLowerCase()]);

    // Loopback aliases keep local development and the container healthcheck usable. They remain
    // protected from DNS rebinding because Host is exact and browser requests also check Origin.
    for (const hostname of LOOPBACK_HOSTS) {
        const local = new URL(`http://${hostname}:${listeningPort}`);
        allowedHosts.add(local.host.toLowerCase());
        allowedOrigins.add(local.origin.toLowerCase());
    }

    return { allowedHosts, allowedOrigins };
}

/** Validates a request before Fastify performs routing or a WebSocket upgrade. */
export function rejectBoundaryRequest(
    boundary: RequestBoundary,
    request: {
        readonly host: string | undefined;
        readonly origin: string | undefined;
        readonly originPolicy: OriginPolicy;
    },
): BoundaryRejection | null {
    const host = normalizedHost(request.host);
    if (!host || !boundary.allowedHosts.has(host)) {
        return { statusCode: 421, error: "request host is not allowed" };
    }
    if (request.originPolicy === "ignore") return null;

    if (!request.origin) {
        return request.originPolicy === "required"
            ? { statusCode: 403, error: "request origin is required" }
            : null;
    }

    let origin: URL;
    try {
        origin = parseHttpOrigin(request.origin, "Origin");
    } catch {
        return { statusCode: 403, error: "request origin is not allowed" };
    }
    if (
        origin.origin.toLowerCase() !== request.origin.toLowerCase() ||
        origin.host.toLowerCase() !== host ||
        !boundary.allowedOrigins.has(origin.origin.toLowerCase())
    ) {
        return { statusCode: 403, error: "request origin is not allowed" };
    }
    return null;
}
