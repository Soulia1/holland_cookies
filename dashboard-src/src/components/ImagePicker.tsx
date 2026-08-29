import { useRef, useState, type DragEvent } from "react";
import { ImagePlus, Link2, X, Loader2 } from "lucide-react";

// Downscale + compress an image file to a small JPEG data URL so it fits
// comfortably inside a Firestore document (docs are capped at ~1MB).
function fileToCompressedDataUrl(file: File, maxSize = 600, quality = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas not supported."));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export default function ImagePicker({
  value,
  onChange,
  fallback = "🍪",
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  fallback?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [url, setUrl] = useState("");

  async function handleFile(file?: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      onChange(await fileToCompressedDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process image.");
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        {/* Preview */}
        <div className="w-16 h-16 rounded-md border bg-muted/40 flex items-center justify-center overflow-hidden shrink-0">
          {value ? (
            <img src={value} alt="preview" className="w-full h-full object-cover" />
          ) : (
            <span className="text-2xl">{fallback}</span>
          )}
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex-1 cursor-pointer rounded-md border border-dashed px-3 py-3 text-center text-xs transition-colors ${
            dragOver ? "border-caramel bg-secondary" : "border-input hover:bg-muted/40"
          }`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <ImagePlus className="w-3.5 h-3.5" /> Click or drag an image here
            </span>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <div className="flex items-center gap-3 text-xs">
        <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => setShowUrl((s) => !s)}>
          <Link2 className="w-3.5 h-3.5" /> Use a URL instead
        </button>
        {value && (
          <button type="button" className="inline-flex items-center gap-1 text-destructive hover:opacity-80"
            onClick={() => { onChange(""); setUrl(""); }}>
            <X className="w-3.5 h-3.5" /> Remove image
          </button>
        )}
        <span className="text-muted-foreground ml-auto">Optional</span>
      </div>

      {showUrl && (
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded-md px-2 py-1.5 text-sm"
            placeholder="https://…/cookie.jpg"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            type="button"
            className="text-xs px-3 rounded-md border hover:bg-muted/40"
            onClick={() => url.trim() && onChange(url.trim())}
          >
            Use
          </button>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
