import { describe, expect, it } from "vitest";
import { fileToDataUrl } from "./file-data-url";

describe("fileToDataUrl", () => {
  it("encodes an uploaded contract without relying on browser FileReader", async () => {
    const bytes = new TextEncoder().encode("合同");
    const dataUrl = await fileToDataUrl({
      type: "text/plain",
      arrayBuffer: async () => bytes.buffer,
    });

    expect(dataUrl).toBe("data:text/plain;base64,5ZCI5ZCM");
  });

  it("uses a safe fallback content type", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const dataUrl = await fileToDataUrl({
      type: "",
      arrayBuffer: async () => bytes.buffer,
    });

    expect(dataUrl).toBe("data:application/octet-stream;base64,AAEC/w==");
  });
});
