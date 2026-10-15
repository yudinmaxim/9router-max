import { describe, it, expect } from "vitest";
import { seal, open, looksSealed, resetSecretBoxKey } from "@/lib/secretBox";

const TOKEN = "Bearer pat_1234567890abcdef";

describe("secretBox", () => {
  it("round-trips a token", async () => {
    const sealed = await seal(TOKEN);
    expect(await open(sealed)).toBe(TOKEN);
  });

  it("round-trips unicode, whitespace and long payloads", async () => {
    for (const value of [" ", "токен-日本語", "a".repeat(4096)]) {
      const sealed = await seal(value);
      expect(await open(sealed)).toBe(value);
    }
  });

  it("treats an empty string as no token at all", async () => {
    expect(await seal("")).toBeNull();
  });

  it("never returns the plaintext as the sealed form", async () => {
    const sealed = await seal(TOKEN);
    expect(sealed).not.toBe(TOKEN);
    expect(sealed).not.toContain("pat_1234567890abcdef");
    expect(sealed.split(":")).toHaveLength(4);
    expect(sealed.startsWith("v1:")).toBe(true);
  });

  it("uses a fresh IV so the same token seals differently every time", async () => {
    const a = await seal(TOKEN);
    const b = await seal(TOKEN);
    expect(a).not.toBe(b);
    expect(await open(a)).toBe(await open(b));
  });

  it("returns null instead of throwing on unusable input", async () => {
    expect(await seal("")).toBeNull();
    expect(await seal(null)).toBeNull();
    expect(await seal(undefined)).toBeNull();
    expect(await seal(42)).toBeNull();

    expect(await open(null)).toBeNull();
    expect(await open("")).toBeNull();
    expect(await open("plaintext-token")).toBeNull();
    expect(await open("v1:only:three:parts")).toBeNull();
    expect(await open("v9:aa:bb:cc")).toBeNull();
  });

  it("rejects a tampered ciphertext rather than returning garbage", async () => {
    const sealed = await seal(TOKEN);
    const flipped = sealed.slice(0, -1) + (sealed.endsWith("f") ? "0" : "f");
    expect(await open(flipped)).toBeNull();
  });

  it("rejects a tampered auth tag", async () => {
    const [, iv, , body] = (await seal(TOKEN)).split(":");
    const tag = Buffer.alloc(16, 7).toString("hex");
    expect(await open(`v1:${iv}:${tag}:${body}`)).toBeNull();
  });

  it("looksSealed only matches the sealed shape", () => {
    expect(looksSealed(`v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(20)}`)).toBe(true);
    expect(looksSealed("v1:short:tag:body")).toBe(false);
    expect(looksSealed("plaintext")).toBe(false);
    expect(looksSealed(null)).toBe(false);
    expect(looksSealed("")).toBe(false);
  });

  it("survives a key cache reset", async () => {
    const sealed = await seal(TOKEN);
    resetSecretBoxKey();
    expect(await open(sealed)).toBe(TOKEN);
  });
});