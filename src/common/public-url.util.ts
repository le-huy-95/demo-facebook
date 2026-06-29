/** Chuyển đường dẫn tương đối thành URL tuyệt đối để Facebook Graph API có thể tải file. */
export function resolvePublicAssetUrl(
  url: string,
  publicBaseUrl: string,
): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const base = publicBaseUrl.replace(/\/$/, '');
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
}
