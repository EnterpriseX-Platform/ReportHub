/**
 * Copy text to the clipboard without ever hanging the caller: in an unfocused tab or embedded
 * browser `navigator.clipboard.writeText` can stay pending forever. Resolves true when copied,
 * false when refused, unavailable or not answered within a second and a half.
 */
export function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return Promise.resolve(false);
  return Promise.race([
    navigator.clipboard.writeText(text).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
  ]);
}
