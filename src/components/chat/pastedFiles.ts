/** Clipboard images usually arrive as a generic "image.png"; name them after the paste. */
export function pastedName(file: File): string {
  const ext = file.type.split("/")[1]?.split("+")[0] || "png";
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  return generic ? `pasted-image.${ext === "jpeg" ? "jpg" : ext}` : file.name;
}

/** The file's contents as base64, without the data URL's prefix. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.readAsDataURL(file);
  });
}
