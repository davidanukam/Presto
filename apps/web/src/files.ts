export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openTextFile(extensions: string[]): Promise<{ name: string; text: string } | null> {
  if (inTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const picked = await dialog.open({
      multiple: false,
      filters: [{ name: "Presto or MusicXML", extensions }],
    });
    if (typeof picked !== "string") return null;
    return { name: picked.split(/[/\\]/).pop() ?? "piece.presto", text: await fs.readTextFile(picked) };
  }
  return pickWithInput(extensions.join(","));
}

export async function saveTextFile(name: string, text: string, extension: string): Promise<void> {
  if (inTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const target = await dialog.save({
      defaultPath: name.endsWith(`.${extension}`) ? name : `${name}.${extension}`,
      filters: [{ name: extension, extensions: [extension] }],
    });
    if (typeof target !== "string") return;
    await fs.writeTextFile(target, text);
    return;
  }
  download(name.endsWith(`.${extension}`) ? name : `${name}.${extension}`, new Blob([text], { type: "text/plain" }));
}

export async function saveBinaryFile(name: string, bytes: Uint8Array, extension: string, mime: string): Promise<void> {
  if (inTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const target = await dialog.save({
      defaultPath: name,
      filters: [{ name: extension, extensions: [extension] }],
    });
    if (typeof target !== "string") return;
    await fs.writeFile(target, bytes);
    return;
  }
  download(name, new Blob([copyBytes(bytes)], { type: mime }));
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function pickWithInput(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void file.text().then((text) => resolve({ name: file.name, text }));
    };
    input.click();
  });
}

export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
