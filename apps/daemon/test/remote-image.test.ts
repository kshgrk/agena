import { describe, expect, test } from "vitest";
import { fetchRemoteImage, isPublicIp } from "../src/remote-image.ts";

describe("remote image SSRF boundary", () => {
  test("rejects local, private, link-local, mapped, and documentation addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ]) {
      expect(isPublicIp(address), address).toBe(false);
    }
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  test("refuses non-HTTPS and loopback URLs before fetching", async () => {
    await expect(
      fetchRemoteImage("http://example.com/image.png"),
    ).rejects.toThrow("credential-free HTTPS");
    await expect(
      fetchRemoteImage("https://127.0.0.1/image.png"),
    ).rejects.toThrow("non-public");
  });
});
