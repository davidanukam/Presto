const SHARE_LIMIT = 30_000;

export async function encodeShare(source: string): Promise<string> {
  if (source.length > 100_000) throw new Error("This piece is too big for a link.");
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const encoded = base64url(bytes);
  if (encoded.length > SHARE_LIMIT) throw new Error("This piece is too big for a link.");
  return encoded;
}

export async function decodeShare(encoded: string): Promise<string> {
  const bytes = fromBase64url(encoded);
  const stream = new Blob([copyBytes(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
