import { describe, expect, it } from "vitest";
import {
  dataUrlBytes,
  MAX_CARGO_IMAGE_STORED_BYTES,
  parseCargoImagePayloads,
} from "./cargo-images";

function image(bytes: number) {
  const payload = Buffer.alloc(bytes).toString("base64");
  return {
    name: "cargo.webp",
    type: "image/webp",
    size: bytes,
    dataUrl: `data:image/webp;base64,${payload}`,
  };
}

describe("cargo image payload validation", () => {
  it("calculates the decoded byte length instead of trusting client metadata", () => {
    expect(dataUrlBytes(image(321).dataUrl)).toBe(321);
  });

  it("accepts compressed cargo images within the D1-safe limit", () => {
    const result = parseCargoImagePayloads(JSON.stringify([image(1000), image(2048)]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.images.map((item) => item.size)).toEqual([1000, 2048]);
  });

  it("rejects a decoded image that exceeds the storage limit", () => {
    const result = parseCargoImagePayloads(
      JSON.stringify([image(MAX_CARGO_IMAGE_STORED_BYTES + 1)]),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects more than five images on one cargo row", () => {
    const result = parseCargoImagePayloads(
      JSON.stringify(Array.from({ length: 6 }, () => image(10))),
    );
    expect(result).toMatchObject({ ok: false });
  });
});
