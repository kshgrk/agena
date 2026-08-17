import { resolve4, resolve6 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

export async function fetchRemoteImage(
  input: string,
  redirects = 0,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    redirects > MAX_REDIRECTS
  ) {
    throw new Error("only credential-free HTTPS image URLs are allowed");
  }
  const address = await publicAddress(url.hostname);
  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: {
          accept:
            "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/bmp",
          "user-agent": "Agena-Media/1",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          void fetchRemoteImage(
            new URL(response.headers.location, url).toString(),
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`image server returned HTTP ${status}`));
          return;
        }
        const declared = String(response.headers["content-type"] ?? "")
          .split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (!declared?.startsWith("image/")) {
          response.resume();
          reject(new Error("remote response is not an image"));
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) {
            req.destroy(new Error("remote image exceeds 3 MB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          resolve({ bytes: Buffer.concat(chunks), mimeType: declared });
        });
        response.once("error", reject);
      },
    );
    req.setTimeout(8_000, () =>
      req.destroy(new Error("remote image timed out")),
    );
    req.once("error", reject);
    req.end();
  });
}

async function publicAddress(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  const literal = isIP(hostname);
  const addresses = literal
    ? [{ address: hostname, family: literal as 4 | 6 }]
    : [
        ...(await resolve4(hostname).catch(() => [])).map((address) => ({
          address,
          family: 4 as const,
        })),
        ...(await resolve6(hostname).catch(() => [])).map((address) => ({
          address,
          family: 6 as const,
        })),
      ];
  const selected = addresses.find(({ address }) => isPublicIp(address));
  if (!selected || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("image URL resolves to a non-public address");
  }
  return selected;
}

export function isPublicIp(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      return isPublicIp(value.slice("::ffff:".length));
    }
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("2001:db8:")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}
