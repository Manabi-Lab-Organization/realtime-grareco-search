export async function fetchImageAsPngBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  const original = await res.blob();
  const objectUrl = URL.createObjectURL(original);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas error'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('image load error'));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function downloadImageAsPng(url: string, filename: string): Promise<void> {
  let href = url;
  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(await fetchImageAsPngBlob(url));
    href = objectUrl;
  } catch {
    href = url;
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) {
    const toRevoke = objectUrl;
    setTimeout(() => URL.revokeObjectURL(toRevoke), 1000);
  }
}
