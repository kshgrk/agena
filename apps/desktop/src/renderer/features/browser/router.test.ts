import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./router.ts";

describe("normalizeBrowserUrl", () => {
  it("keeps http/https untouched", () => {
    expect(normalizeBrowserUrl("https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(normalizeBrowserUrl("http://foo.dev")).toBe("http://foo.dev/");
  });

  it("gives loopback http, not a bogus scheme", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(normalizeBrowserUrl("127.0.0.1:8080/app")).toBe(
      "http://127.0.0.1:8080/app",
    );
    expect(normalizeBrowserUrl("localhost")).toBe("http://localhost/");
  });

  it("adds https to scheme-less domains", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
  });

  it("rejects dangerous or non-web schemes and junk", () => {
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("data:text/html,x")).toBeNull();
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("mailto:a@b.com")).toBeNull();
    expect(normalizeBrowserUrl("just some words")).toBeNull();
    expect(normalizeBrowserUrl("  ")).toBeNull();
  });
});
