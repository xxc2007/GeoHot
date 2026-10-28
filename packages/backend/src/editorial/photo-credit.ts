export function isImmutablePhotoCredit(tagName: string, text: string): boolean {
  // Deliberately narrow: a single photographer username, not a descriptive English caption.
  return tagName === "figcaption" && /^[A-Za-z][A-Za-z0-9._-]{1,63}\s*\/\s*Getty(?:\s+Images)?$/i.test(text.trim());
}
