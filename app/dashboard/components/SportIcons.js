'use client';

import { useId } from 'react';

/**
 * Iconografía deportiva del selector de la cabecera.
 *
 * Los trazos originales (SVG entregados por diseño) se conservan intactos; lo
 * único que cambia es el sistema de color: la tinta usa `currentColor` para
 * heredar el estado del botón (inactivo / hover / activo) y las zonas claras
 * usan `--sport-ico-paper`, que siempre coincide con el fondo del selector para
 * que los huecos del dibujo se recorten limpios sobre la barra oscura.
 */

const PAPER = 'var(--sport-ico-paper, #08151c)';

// `useId()` incluye `:` en React 18; se limpian para que el id sea seguro tanto
// en las referencias `url(#…)` como en cualquier selector CSS.
function useSvgId(prefix) {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function svgProps(size) {
  return {
    width: size,
    height: size,
    focusable: 'false',
    'aria-hidden': 'true',
  };
}

export function FutbolIcon({ size = 22, className = '' }) {
  const clip = useSvgId('sport-futbol');
  return (
    <svg className={className} viewBox="-230 -230 460 460" {...svgProps(size)}>
      <circle cx="0" cy="0" r="200" fill={PAPER} stroke="currentColor" strokeWidth="14" />
      <clipPath id={clip}>
        <circle cx="0" cy="0" r="193" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <polygon points="0.0,-78.0 -74.2,-24.1 -45.8,63.1 45.8,63.1 74.2,-24.1" fill="currentColor" />
        <polygon points="-68.8,-94.7 -44.1,-170.7 -108.7,-217.7 -173.4,-170.7 -148.7,-94.7" fill="currentColor" />
        <polygon points="-111.3,36.2 -175.9,-10.8 -240.6,36.2 -215.9,112.2 -136.0,112.2" fill="currentColor" />
        <polygon points="-0.0,117.0 -64.7,164.0 -40.0,240.0 40.0,240.0 64.7,164.0" fill="currentColor" />
        <polygon points="111.3,36.2 136.0,112.2 215.9,112.2 240.6,36.2 175.9,-10.8" fill="currentColor" />
        <polygon points="68.8,-94.7 148.7,-94.7 173.4,-170.7 108.7,-217.7 44.1,-170.7" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="12">
          <line x1="0.0" y1="-78.0" x2="0.0" y2="-150.0" />
          <line x1="0.0" y1="-150.0" x2="108.7" y2="-149.7" />
          <line x1="0.0" y1="-150.0" x2="-108.7" y2="-149.7" />
          <line x1="-74.2" y1="-24.1" x2="-142.7" y2="-46.4" />
          <line x1="-142.7" y1="-46.4" x2="-108.7" y2="-149.7" />
          <line x1="-142.7" y1="-46.4" x2="-175.9" y2="57.2" />
          <line x1="-45.8" y1="63.1" x2="-88.2" y2="121.4" />
          <line x1="-88.2" y1="121.4" x2="-175.9" y2="57.2" />
          <line x1="-88.2" y1="121.4" x2="-0.0" y2="185.0" />
          <line x1="45.8" y1="63.1" x2="88.2" y2="121.4" />
          <line x1="88.2" y1="121.4" x2="-0.0" y2="185.0" />
          <line x1="88.2" y1="121.4" x2="175.9" y2="57.2" />
          <line x1="74.2" y1="-24.1" x2="142.7" y2="-46.4" />
          <line x1="142.7" y1="-46.4" x2="175.9" y2="57.2" />
          <line x1="142.7" y1="-46.4" x2="108.7" y2="-149.7" />
        </g>
      </g>
    </svg>
  );
}

const BAT_PATH = 'M -30,-220 C -30,-236 -14,-242 0,-242 C 14,-242 30,-236 30,-220 L 28,-140 C 26,-80 18,-20 12,40 C 10,70 9,120 9,168 L -9,168 C -9,120 -10,70 -12,40 C -18,-20 -26,-80 -28,-140 Z';

const BASEBALL_SEAMS = [
  [218, 66, 203, 56], [218, 66, 203, 76],
  [209, 88, 194, 78], [209, 88, 194, 98],
  [205, 110, 190, 100], [205, 110, 190, 120],
  [205, 132, 190, 122], [205, 132, 190, 142],
  [210, 154, 195, 144], [210, 154, 195, 164],
  [219, 176, 204, 166], [219, 176, 204, 186],
  [282, 66, 297, 56], [282, 66, 297, 76],
  [291, 88, 306, 78], [291, 88, 306, 98],
  [295, 110, 310, 100], [295, 110, 310, 120],
  [295, 132, 310, 122], [295, 132, 310, 142],
  [290, 154, 305, 144], [290, 154, 305, 164],
  [281, 176, 296, 166], [281, 176, 296, 186],
];

export function BaseballIcon({ size = 22, className = '' }) {
  return (
    <svg className={className} viewBox="0 0 500 500" {...svgProps(size)}>
      {[-38, 38].map((angle) => (
        <g key={angle} transform={`translate(250,258) rotate(${angle})`} fill="currentColor" stroke={PAPER} strokeWidth="6">
          <path d={BAT_PATH} />
          <ellipse cx="0" cy="180" rx="19" ry="12" />
        </g>
      ))}
      <circle cx="250" cy="120" r="80" fill={PAPER} stroke="currentColor" strokeWidth="7" />
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M 226,50 C 202,85 202,155 226,190" strokeWidth="6" />
        <path d="M 274,50 C 298,85 298,155 274,190" strokeWidth="6" />
        <g strokeWidth="5">
          {BASEBALL_SEAMS.map(([x1, y1, x2, y2]) => (
            <line key={`${x1}-${y1}-${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
      </g>
    </svg>
  );
}

export function BaloncestoIcon({ size = 22, className = '' }) {
  const clip = useSvgId('sport-basket');
  return (
    <svg className={className} viewBox="0 0 500 500" {...svgProps(size)}>
      <circle cx="250" cy="250" r="200" fill={PAPER} stroke="currentColor" strokeWidth="16" />
      <clipPath id={clip}>
        <circle cx="250" cy="250" r="192" />
      </clipPath>
      <g clipPath={`url(#${clip})`} fill="none" stroke="currentColor" strokeWidth="16">
        <path d="M 305,52 C 200,140 198,362 300,448" />
        <path d="M 52,220 C 190,258 380,262 450,222" />
        <path d="M 165,72 C 228,142 232,192 172,258 C 128,306 116,360 145,438" />
        <path d="M 448,140 C 385,198 345,208 282,192" />
      </g>
    </svg>
  );
}

export function FutbolAmericanoIcon({ size = 22, className = '' }) {
  return (
    <svg className={className} viewBox="0 0 640 640" {...svgProps(size)}>
      {/* concha */}
      <path
        d="M 290,120 C 175,120 90,210 90,325 C 90,400 125,460 185,495 C 235,522 290,528 340,520 C 380,514 410,505 430,492 C 445,490 455,478 460,462 L 470,300 C 455,195 385,120 290,120 Z"
        fill="currentColor"
      />
      {/* brillo superior */}
      <path d="M 150,240 C 190,170 270,135 340,142 C 275,150 205,190 165,258 Z" fill={PAPER} />
      {/* costuras tipo balon */}
      <g stroke={PAPER} strokeWidth="13" strokeLinecap="round">
        <line x1="165" y1="345" x2="315" y2="195" />
        <line x1="182" y1="302" x2="222" y2="342" />
        <line x1="212" y1="272" x2="252" y2="312" />
        <line x1="242" y1="242" x2="282" y2="282" />
        <line x1="272" y1="212" x2="312" y2="252" />
      </g>
      {/* agujero de oreja */}
      <ellipse cx="245" cy="470" rx="36" ry="26" fill={PAPER} />
      {/* soporte mascara */}
      <rect x="418" y="292" width="70" height="34" rx="10" fill="currentColor" transform="rotate(8 453 309)" />
      <rect x="426" y="298" width="54" height="22" rx="8" fill={PAPER} transform="rotate(8 453 309)" />
      <circle cx="430" cy="440" r="16" fill={PAPER} />
      <circle cx="430" cy="440" r="6" fill="currentColor" />
      {/* mascara (barras) */}
      <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
        <path d="M 470,305 L 530,315 C 575,325 595,360 592,400 C 588,465 540,520 465,545 C 425,558 385,552 358,535" />
        <path d="M 448,380 L 545,392 C 570,396 582,412 580,435" />
        <path d="M 445,455 L 530,468 C 552,472 562,482 564,495" />
        <line x1="520" y1="318" x2="500" y2="538" />
      </g>
    </svg>
  );
}

// Cuerdas de la raqueta: 19 alturas equiespaciadas (paso 34) cruzadas en aspa.
const RACKET_STRINGS = Array.from({ length: 19 }, (_, index) => -436 + index * 34);

export function TenisIcon({ size = 22, className = '' }) {
  const uid = useSvgId('sport-tenis');
  return (
    <svg className={className} viewBox="0 0 620 640" {...svgProps(size)}>
      {[-33, 33].map((angle, index) => {
        const clip = `${uid}-${index}`;
        return (
          <g key={angle} transform={`translate(310,570) rotate(${angle} 0 -125)`}>
            <ellipse cx="0" cy="-330" rx="118" ry="148" fill="currentColor" />
            <ellipse cx="0" cy="-330" rx="94" ry="124" fill={PAPER} />
            <clipPath id={clip}>
              <ellipse cx="0" cy="-330" rx="94" ry="124" />
            </clipPath>
            <g clipPath={`url(#${clip})`} stroke="currentColor" strokeWidth="11">
              {RACKET_STRINGS.map((y) => (
                <line key={`a${y}`} x1="-200" y1={y} x2="200" y2={y - 400} />
              ))}
              {RACKET_STRINGS.map((y) => (
                <line key={`b${y}`} x1="-200" y1={y - 400} x2="200" y2={y} />
              ))}
            </g>
            <path
              d="M -62,-215 C -34,-178 -20,-160 -15,-138 L 15,-138 C 20,-160 34,-178 62,-215 L 34,-232 C 20,-198 10,-186 0,-186 C -10,-186 -20,-198 -34,-232 Z"
              fill="currentColor"
            />
            <path d="M -15,-140 L 15,-140 L 17,-18 L -17,-18 Z" fill="currentColor" />
            <rect x="-23" y="-20" width="46" height="20" rx="7" fill="currentColor" />
          </g>
        );
      })}
      <g>
        <circle cx="310" cy="100" r="58" fill="currentColor" />
        <path d="M 272,56 C 310,78 316,122 298,156" fill="none" stroke={PAPER} strokeWidth="13" />
        <path d="M 360,70 C 330,90 326,124 350,148" fill="none" stroke={PAPER} strokeWidth="13" />
      </g>
    </svg>
  );
}
