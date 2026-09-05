/**
 * Node identity for newly authored content.
 *
 * `crypto.randomUUID` only exists in a secure context. A self-hosted editor is normally reached
 * over plain HTTP on a LAN address — `http://172.20.0.38:8080` is the deployment this project
 * actually runs — where the property is simply missing, so calling it throws and every "add" button
 * in the editor dies with a TypeError. `crypto.getRandomValues` has no such restriction, so the
 * fallback is a real version 4 UUID from the same CSPRNG rather than a weaker id.
 */
export function newUuid(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
    ].join("-");
}
