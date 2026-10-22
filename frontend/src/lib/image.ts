/**
 * Client-side image preparation: the S23 produces 12 MP JPEGs (3–5 MB);
 * Gemini reads a page perfectly well at ~1600 px on the long edge, which keeps
 * uploads around 200–400 kB on mobile data.
 */
export interface PreparedImage {
  mime_type: string;
  /** base64 payload without the data: prefix */
  data: string;
  /** object URL for previews – revoke when done */
  previewUrl: string;
  originalBytes: number;
  bytes: number;
  width: number;
  height: number;
}

const MAX_EDGE = 1600;
const QUALITY = 0.82;

export async function prepareImage(file: File | Blob, maxEdge = MAX_EDGE): Promise<PreparedImage> {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if ('close' in bitmap) (bitmap as ImageBitmap).close();

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', QUALITY),
  );
  const data = await blobToBase64(blob);
  return {
    mime_type: 'image/jpeg',
    data,
    previewUrl: URL.createObjectURL(blob),
    originalBytes: file.size,
    bytes: blob.size,
    width,
    height,
  };
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // imageOrientation: 'from-image' applies the EXIF rotation that phone cameras rely on.
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      /* fall through to <img> (e.g. HEIC on some browsers) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This image format is not supported by your browser'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read image'));
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.readAsDataURL(blob);
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
