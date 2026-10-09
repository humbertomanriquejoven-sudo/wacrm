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
// Recipient addressing — an opaque Meta id travels in `recipient`,
// a phone number in `to`.
//
// Putting an opaque id (a BSUID / long numeric id) in `to` is what
// makes Meta answer (#131009) "el formato del número de teléfono es
// incorrecto" and drop the message. Media shares the SAME routing as
// text/template (`canonicalToField`), so all three address an opaque
// id identically.
// ---------------------------------------------------------------
describe("sendMediaMessage — recipient addressing", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts an E.164 number in `to` as bare digits", async () => {
    await sendMediaMessage({ ...BASE, to: "+57 304 455 6788", kind: "image" });
    expect(captured?.to).toBe("573044556788");
    expect(captured?.recipient).toBeUndefined();
  });

  it("puts a numeric BSUID in `recipient`, never in `to`", async () => {
    // The contact's ONLY identity is the 16-digit id the `@user`/`@lid`
    // sender resolves to. Meta reads it from `recipient`; in `to` it is
    // rejected with (#131009).
    await sendMediaMessage({ ...BASE, to: "1486998326437295", kind: "image" });
    expect(captured?.recipient).toBe("1486998326437295");
    expect(captured?.to).toBeUndefined();
  });

  it("keeps a CO./WAID. namespace intact and sends it in `recipient`", async () => {
    await sendMediaMessage({ ...BASE, to: "CO.1486998326437295", kind: "document" });
    expect(captured?.recipient).toBe("CO.1486998326437295");
    expect(captured?.to).toBeUndefined();
  });

  it("drops an `@user` / `@lid` routing suffix before addressing", async () => {
    await sendMediaMessage({ ...BASE, to: "1486998326437295@lid", kind: "image" });
    expect(captured?.recipient).toBe("1486998326437295");
    expect(captured?.to).toBeUndefined();
  });

  it("NEVER sends a handle — ESCENARIO C refuses before the wire", async () => {
    // A bare `@username` in `to` answers (#100) Invalid parameter whether or
    // not an anchor is quoted. Media now refuses both handle spellings
    // locally (InvalidRecipientError) instead of probing Meta.
    await expect(
      sendMediaMessage({ ...BASE, to: "@acme.store", kind: "image" }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);
    await expect(
      sendMediaMessage({ ...BASE, to: "@jjuanpablo22222", kind: "image" }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);
    await expect(
      sendMediaMessage({ ...BASE, to: "jjuanpablo22222", kind: "image" }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);
    expect(captured).toBeNull();
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
