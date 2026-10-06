import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidRecipientError, sendMediaMessage } from "./meta-api";

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  to?: string;
  recipient?: string;
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}
let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    await sendMediaMessage({ ...BASE, kind: "image", caption: "hello", filename: "x.png" });
    expect(captured?.type).toBe("image");
    expect(captured?.image).toEqual({ link: BASE.link, caption: "hello" });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it("sends document with both caption and filename", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: "invoice",
      filename: "invoice.pdf",
    });
  });

  it("sends audio with NO caption and NO filename (Meta rejects both)", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured?.type).toBe("audio");
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it("throws when no link is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link/);
  });
});

// ---------------------------------------------------------------
// Recipient addressing — the path that made `@user` contacts
// undeliverable by media while their TEXT messages went through.
//
// The text sender addresses every contact in Meta's `to`
// (`sendTextMessage` / `canonicalToField`). Media used to route opaque
// ids through the alternate `recipient` field, which Meta rejects for
// this message type — the request 400'd and the route surfaced it as
// HTTP 502. These tests pin media to the same `to` shape.
// ---------------------------------------------------------------
describe("sendMediaMessage — recipient addressing (text-path parity)", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts an E.164 number in `to` as bare digits", async () => {
    await sendMediaMessage({ ...BASE, to: "+57 316 707 1066", kind: "image" });
    expect(captured?.to).toBe("573167071066");
    expect(captured?.recipient).toBeUndefined();
  });

  it("puts a numeric BSUID in `to`, never in `recipient` (the @user 502)", async () => {
    // The contact's ONLY identity is the 16-digit id the `@user`/`@lid`
    // sender resolves to. This exact shape failed before the unification.
    await sendMediaMessage({ ...BASE, to: "1486998326437295", kind: "image" });
    expect(captured?.to).toBe("1486998326437295");
    expect(captured?.recipient).toBeUndefined();
  });

  it("strips the namespace off a CO./WAID. id and sends it in `to`", async () => {
    await sendMediaMessage({ ...BASE, to: "CO.1486998326437295", kind: "document" });
    expect(captured?.to).toBe("1486998326437295");
    expect(captured?.recipient).toBeUndefined();
  });

  it("drops an `@user` / `@lid` routing suffix before addressing", async () => {
    await sendMediaMessage({ ...BASE, to: "1486998326437295@lid", kind: "image" });
    expect(captured?.to).toBe("1486998326437295");
    expect(captured?.recipient).toBeUndefined();
  });

  it("strips a leading @ from a handle and forwards the rest intact", async () => {
    await sendMediaMessage({ ...BASE, to: "@acme.store", kind: "image" });
    expect(captured?.to).toBe("acme.store");
    expect(captured?.recipient).toBeUndefined();
  });

  it("never reduces a digits-bearing handle to a number we invented", async () => {
    await sendMediaMessage({ ...BASE, to: "@jjuanpablo22222", kind: "image" });
    expect(captured?.to).toBe("jjuanpablo22222");
    expect(captured?.to).not.toMatch(/^\d+$/);
  });

  it("refuses a placeholder recipient without sending a request", async () => {
    // `contacts.phone` is NOT NULL, so the webhook writes the literal
    // string 'unknown' for senders Meta could not identify.
    await expect(
      sendMediaMessage({ ...BASE, to: "unknown", kind: "image" }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);
    expect(captured).toBeNull();
  });

  it("refuses an empty recipient without sending a request", async () => {
    await expect(
      sendMediaMessage({ ...BASE, to: "   ", kind: "image" }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);
    expect(captured).toBeNull();
  });
});
