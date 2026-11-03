'use client';

import { useSyncExternalStore } from 'react';

/**
 * Column count for the deal grid, matched to the Tailwind breakpoints the
 * static grid used before virtualization: 1 below md, 2 at md, 3 at lg.
 */
const LG_QUERY = '(min-width: 1024px)';
const MD_QUERY = '(min-width: 768px)';

let mediaLists: [MediaQueryList, MediaQueryList] | null = null;

function lists(): [MediaQueryList, MediaQueryList] {
  mediaLists ??= [window.matchMedia(LG_QUERY), window.matchMedia(MD_QUERY)];
  return mediaLists;
}

function subscribe(onChange: () => void): () => void {
  const [lg, md] = lists();
  lg.addEventListener('change', onChange);
  md.addEventListener('change', onChange);
  return () => {
    lg.removeEventListener('change', onChange);
    md.removeEventListener('change', onChange);
  };
}

function getSnapshot(): number {
  const [lg, md] = lists();
  if (lg.matches) return 3;
  if (md.matches) return 2;
  return 1;
}

/** Server and hydration render use three columns; the client corrects after. */
function getServerSnapshot(): number {
  return 3;
}

export function useColumns(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
