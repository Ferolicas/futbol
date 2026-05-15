'use client';

import { useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

/**
 * Lista virtualizada de fixtures basada en useWindowVirtualizer.
 *
 * Por que window-scroll y no container-scroll:
 *   En cfanalisis el scroll es page-level (mobile-first, no hay un panel
 *   con overflow). useWindowVirtualizer escucha el scroll del documento
 *   y mide el offsetTop del contenedor para calcular el viewport relativo
 *   — sin necesidad de fijar height al wrapper. Drop-in para un `.map()`.
 *
 * Uso:
 *   <VirtualFixtureList
 *     items={sorted}
 *     getItemKey={(m) => m.fixture.id}
 *     estimateSize={110}
 *     renderItem={(m, i) => <MatchCard match={m} idx={i} ... />}
 *   />
 */
export default function VirtualFixtureList({
  items,
  renderItem,
  estimateSize = 110,
  overscan = 6,
  className = '',
  getItemKey,
}) {
  const listRef = useRef(null);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    overscan,
    // scrollMargin compensa el espacio entre el viewport y el contenedor
    // (header, tabs, banner). Sin esto los items aparecerian desplazados.
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: getItemKey
      ? (index) => getItemKey(items[index], index)
      : undefined,
  });

  const totalSize = virtualizer.getTotalSize();
  const offsetTop = listRef.current?.offsetTop ?? 0;

  return (
    <div
      ref={listRef}
      className={className}
      style={{
        position: 'relative',
        height: `${totalSize}px`,
        width: '100%',
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => (
        <div
          key={virtualRow.key}
          data-index={virtualRow.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start - offsetTop}px)`,
          }}
        >
          {renderItem(items[virtualRow.index], virtualRow.index)}
        </div>
      ))}
    </div>
  );
}
