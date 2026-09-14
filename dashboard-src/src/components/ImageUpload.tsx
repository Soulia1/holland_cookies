import { useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { Btn } from "@/components/menu-ui";
import { imagesApi } from "@/lib/api";

/**
 * A product's photo: pick one, see it, replace or remove it.
 *
 * Shrunk here, before upload: a phone camera's 4 MB original becomes a WebP of
 * at most MAX_EDGE px under the server's 750 KiB cap. `createImageBitmap`
 * rather than an `<img>` on a blob: URL, because the CSP's `img-src` does not
 * admit `blob:`.
 */

const MAX_EDGE = 1600;
const TARGET_BYTES = 700 * 1024;

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function shrink(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This photo could not be read. Use a JPEG or PNG.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the photo.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.85, 0.72, 0.6, 0.45]) {
    let blob = await toBlob(canvas, "image/webp", quality);
    // Older Safari silently hands back a PNG when asked for WebP.
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= TARGET_BYTES) return blob;
  }
  throw new Error("That photo is too large, even after shrinking it.");
}

export function ImageUpload({
  id, value, fallback, onChange, onBusyChange,
}: {
  id: string;
  value: string;
  /**
   * The picture the shop shows when `value` is empty — the storefront's built-in
   * menu photo. Shown so the editor matches the page; it cannot be removed,
   * because clearing `value` is exactly what makes the shop show it.
   */
  fallback?: string;
  onChange: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = value || fallback;

  async function upload(file: File) {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      onChange(await imagesApi.upload(await shrink(file)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the photo.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
        {shown ? (
          <img src={shown} alt="Product photo" className="size-full object-cover" data-testid="product-photo" />
        ) : (
          <ImageIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Btn type="button" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : shown ? "Replace photo" : "Upload photo"}
          </Btn>
          {value && (
            <Btn type="button" variant="ghost" disabled={busy} className="text-destructive"
              onClick={() => onChange("")}>
              Remove
            </Btn>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {value
            ? "JPEG, PNG or WebP. Resized automatically."
            : fallback
              ? "The shop's current menu photo. Upload one to replace it."
              : "JPEG, PNG or WebP. Resized automatically."}
        </p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      <input
        ref={input}
        id={id}
        type="file"
        // `image/*` makes iOS convert a HEIC photo to JPEG.
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
