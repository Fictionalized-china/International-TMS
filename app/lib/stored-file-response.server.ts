export function storedDataUrlResponse(input: {
  dataUrl: string;
  fileName: string;
  contentType?: string | null;
  disposition?: "inline" | "attachment";
}) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(input.dataUrl);
  if (!match) throw new Response("文件数据无效", { status: 422 });

  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Response("文件数据损坏", { status: 422 });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return new Response(bytes, {
    headers: {
      "Content-Type": input.contentType || match[1] || "application/octet-stream",
      "Content-Disposition": `${input.disposition || "attachment"}; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
