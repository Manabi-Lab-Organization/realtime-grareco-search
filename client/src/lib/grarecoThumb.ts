export function grarecoThumbUrl(imageUrl: string): string {
  return /^\/api\/(meetings\/\d+|share\/[^/?#]+)\/grareco\/\d+\/image$/.test(imageUrl)
    ? `${imageUrl}?size=thumb`
    : imageUrl;
}
