/**
 * Sheets (海报、目录、图片灯箱) mount their content through `Presence`, which flips its own phase in an
 * effect — so in the same commit where `open` becomes true, the close button does not exist yet, and
 * `closeButton.current?.focus()` inside that effect silently does nothing. Measured live on
 * https://xxc2007.me/geohot: the sheet opened with `aria-modal="true"` while `document.activeElement`
 * stayed on `<main>`, which is exactly the state where Tab walks out into the page behind the scrim.
 *
 * Retry on the frames that actually render the button, and cancel when the sheet closes.
 */
export function focusWhenReady(target: () => HTMLElement | null | undefined, attempts = 10): () => void {
  let raf = 0;
  let left = attempts;
  const step = () => {
    const el = target();
    if (el) el.focus({ preventScroll: true });
    else if (--left > 0) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/**
 * Hand focus back to wherever the reader came from — but only while that control is still on the page.
 * An overlay opened from a dropdown records `document.activeElement` at mount, and the menu item that
 * launched it unmounts 140 ms later (`Menu`'s exit animation): focusing that detached node is a no-op
 * that leaves a keyboard reader on `<body>`, i.e. back at the top of the tab order. `Menu` returns focus
 * to its own trigger as it closes, so leaving focus alone is the better answer when the opener is gone.
 */
export function returnFocus(el: HTMLElement | null): void {
  if (el?.isConnected) el.focus({ preventScroll: true });
}
