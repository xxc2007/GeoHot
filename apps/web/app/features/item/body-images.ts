export interface BodyPicture { src: string; alt: string }

/** Enhance sanitized article HTML without changing signed URLs, captions, or publisher links. */
export function enhanceBodyImages(root: ParentNode) {
  const entries = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]')).filter(image =>
    /^(?:https?:\/\/|\/(?!\/)|data:image\/(?:png|jpe?g|webp|gif|avif);)/i.test(image.getAttribute('src') ?? '')
  ).map((image, index) => ({
    image,
    trigger: image.closest<HTMLAnchorElement>('a') ?? image,
    // src is the independently signed full image. currentSrc may be a small responsive rendition.
    src: image.getAttribute('src')!,
    alt: image.getAttribute('alt') || image.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || `正文配图 ${index + 1}`,
  }));
  const saved = new Map<HTMLElement, Array<[string, string | null]>>();
  for (const entry of entries) {
    const node = entry.trigger;
    if (saved.has(node)) continue;
    saved.set(node, ['role', 'tabindex', 'aria-label', 'class'].map(name => [name, node.getAttribute(name)]));
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', `查看大图：${entry.alt.slice(0, 160)}`);
    node.classList.add('cursor-zoom-in');
  }
  return {
    images: entries.map(({src, alt}) => ({src, alt})),
    indexOf(target: Element | null) {
      const direct = entries.findIndex(entry => entry.image === target);
      return direct >= 0 ? direct : entries.findIndex(entry => entry.trigger === target);
    },
    focus(index: number) { entries[index]?.trigger.focus(); },
    restore() {
      for (const [node, attributes] of saved) for (const [name, value] of attributes) {
        if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
      }
    },
  };
}
