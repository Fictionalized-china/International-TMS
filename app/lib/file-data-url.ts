export async function fileToDataUrl(
  file: Pick<Blob, "arrayBuffer" | "type">,
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
