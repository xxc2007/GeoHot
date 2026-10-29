import {useEffect, useRef, useState, type MouseEvent, type KeyboardEvent} from 'react';
import {Lightbox} from '../../components/ui/Lightbox';
import {enhanceBodyImages, type BodyPicture} from './body-images';

export function ArticleBody({html}: {html: string}) {
  const root = useRef<HTMLDivElement>(null);
  const gallery = useRef<ReturnType<typeof enhanceBodyImages> | null>(null);
  const [images, setImages] = useState<BodyPicture[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const enhanced = enhanceBodyImages(root.current);
    gallery.current = enhanced;
    setImages(enhanced.images);
    setIndex(null);
    return () => { enhanced.restore(); gallery.current = null; };
  }, [html]);
  const open = (target: EventTarget | null) => {
    const at = gallery.current?.indexOf(target instanceof Element ? target : null) ?? -1;
    if (at < 0) return false;
    gallery.current?.focus(at);
    setIndex(at);
    return true;
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (open(event.target)) event.preventDefault();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && open(event.target)) event.preventDefault();
  };
  return <>
    <div ref={root} className="prose" onClick={click} onKeyDown={keyDown} dangerouslySetInnerHTML={{__html: html}} />
    <Lightbox images={images} index={index} onIndex={setIndex} onClose={() => setIndex(null)} />
  </>;
}
