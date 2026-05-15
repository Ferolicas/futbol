'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Lista virtualizada de fixtures.
 *
 * Renderiza solo los partidos visibles + un buffer (overscan). Para listas
 * largas (200+ matches en dias de Champions/finales) reduce el DOM de
 * miles de nodos a ~30, recuperando 60fps en mobile gama baja.
 *
 * Uso minimo:
 *   <VirtualFixtureList items={fixtures} renderItem={(f) => <MatchCard ... />} />
 *
 * Asume altura aproximada `estimateSize` (96px por card por defecto). Si las
 * cards son muy variables, react-virtual mide y reajusta solo.
 */
export default function VirtualFixtureList({
  items,
  renderItem,
  estimateSize = 96,
  overscan = 6,
  className = '',
  style,
  getItemKey,
}) {
  const parentRef = useRef(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: getItemKey
      ? (index) => getItemKey(items[index], index)
      : undefined,
  });

  return (
    <div
      ref={parentRef}
      className={className}
      style={{
        overflowY: 'auto',
        // contain:strict permite que el browser ignore reflow/repaint fuera del
        // contenedor — mejora aun mas el render.
        contain: 'strict',
        ...style,
      }}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderItem(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
