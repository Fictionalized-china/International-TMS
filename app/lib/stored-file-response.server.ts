export function storedDataUrlResponse(input: {
  dataUrl: string;
  fileName: string;
  contentType?: string | null;
  disposition?: "inline" | "attachment";
}) {
  const match = /^data:([^,]+),([\s\S]*)$/.exec(input.dataUrl);
  if (!match) throw new Response("文件数据无效", { status: 422 });

  let bytes: Uint8Array;
  try {
    if (/(?:^|;)base64$/i.test(match[1])) {
      bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
    } else if (/^text\/html(?:;charset=utf-8)?$/i.test(match[1])) {
      bytes = new TextEncoder().encode(decodeURIComponent(match[2]));
    } else {
      throw new Error("Unsupported stored encoding");
    }
  } catch {
    throw new Response("文件数据损坏", { status: 422 });
  }
  const contentType = input.contentType || match[1].split(";")[0] || "application/octet-stream";

  return new Response(new Uint8Array(bytes).buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${input.disposition || "attachment"}; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Generated manifests are documents, never an authenticated application origin.
      "Content-Security-Policy": "sandbox allow-modals; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}
