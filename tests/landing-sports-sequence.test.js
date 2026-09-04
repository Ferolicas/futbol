const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const SPORTS = ['football', 'baseball', 'basketball', 'helmet'];

const keyframesOf = (styles, name) => {
  const start = styles.indexOf(`@keyframes ${name} {`);
  assert.ok(start >= 0, `falta @keyframes ${name}`);
  const end = styles.indexOf('\n}', start);
  return styles.slice(start, end);
};

// Devuelve, para cada porcentaje declarado, la opacidad que fija ese paso.
const opacityStops = (block) => {
  const stops = [];
  for (const [, heads, body] of block.matchAll(/^\s*([\d.%,\s]+)\{([^}]*)\}/gm)) {
    const opacity = body.match(/opacity:\s*([\d.]+)/);
    if (!opacity) continue;
    for (const head of heads.split(',')) {
      const percent = Number.parseFloat(head);
      if (Number.isFinite(percent)) stops.push({ percent, opacity: Number.parseFloat(opacity[1]) });
    }
  }
  return stops.sort((a, b) => a.percent - b.percent);
};

test('el hero monta los cuatro recortes deportivos debajo de sus métricas', () => {
  const landing = read('app/page.js');
  const statsPosition = landing.indexOf('className="apple-hero-stats"');
  const sequencePosition = landing.indexOf('{activeScene === 0 && <SportsSequence />}');

  assert.ok(statsPosition >= 0);
  assert.ok(sequencePosition > statsPosition);
  for (const sport of SPORTS) {
    assert.match(landing, new RegExp(`/sports-sequence/${sport}\\.webp`));
    assert.ok(fs.existsSync(path.join(root, `public/sports-sequence/${sport}.webp`)));
  }
});

// Lee ancho y alto de un WebP sin decodificarlo (cabeceras VP8X / VP8L / VP8).
const webpSize = (file) => {
  const buffer = fs.readFileSync(path.join(root, file));
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF', `${file} no es RIFF`);
  assert.equal(buffer.toString('ascii', 8, 12), 'WEBP', `${file} no es WEBP`);
  const fourcc = buffer.toString('ascii', 12, 16);

  if (fourcc === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  if (fourcc === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`${file}: cabecera WebP desconocida (${fourcc})`);
};

test('los cuatro recortes comparten lienzo y la máscara cubre la fila completa', () => {
  // Cada objeto ocupa exactamente un cuarto de la caja, así que los recortes
  // deben medir lo mismo y la máscara del brillo, cuatro veces ese ancho.
  const sizes = SPORTS.map((sport) => webpSize(`public/sports-sequence/${sport}.webp`));
  const [reference] = sizes;

  for (const [index, size] of sizes.entries()) {
    assert.deepEqual(size, reference, `${SPORTS[index]}.webp no comparte lienzo con ${SPORTS[0]}.webp`);
  }

  const mask = webpSize('public/sports-sequence/lineup-mask.webp');
  assert.equal(mask.width, reference.width * SPORTS.length, 'la máscara no cubre los cuatro huecos');
  assert.equal(mask.height, reference.height, 'la máscara no comparte alto con los recortes');

  // La caja del hero declara esa misma proporción; si divergen, la máscara se desalinea.
  const styles = read('app/globals.css');
  assert.match(styles, new RegExp(`aspect-ratio: ${mask.width} / ${mask.height}`));
});

// Geometría del recorte, en unidades del alto de la fila.
const BALL_TOP_IN_CANVAS = 76 / 440;   // primera fila con balón dentro del lienzo
const ORIGIN = 0.76;                   // transform-origin: 50% 76%
const ROW_RATIO = 440 / 1536;          // alto de la fila / ancho de la caja

test('el hueco de caída deja entrar los balones sin cortarlos por arriba', () => {
  const styles = read('app/globals.css');

  const dropFactor = Number.parseFloat(
    styles.match(/--sports-drop:\s*calc\(var\(--sports-width\)\s*\*\s*(\.?[\d.]+)\)/)[1],
  );
  // El escenario recorta a esta altura por encima del borde superior de la fila.
  const headroom = dropFactor / ROW_RATIO;

  // Los objetos se anclan abajo: translateY 0 es la posición final.
  assert.match(styles, /\.apple-sport-object \{[\s\S]*?bottom: 0;/);
  assert.match(styles, /\.apple-sports-sequence \{[\s\S]*?box-sizing: content-box;/);

  let worst = { above: -Infinity };
  for (const sport of ['Football', 'Baseball', 'Basketball', 'Helmet']) {
    const block = keyframesOf(styles, `appleSport${sport}`);
    for (const [, percent, y, scale] of block.matchAll(
      /^\s*([\d.%,\s]+)\{[^}]*translate3d\(-50%,(-?[\d.]+)%,0\)\s*scale\((\.?[\d.]+)\)/gm,
    )) {
      const ty = Number.parseFloat(y) / 100;
      const s = Number.parseFloat(scale);
      // Borde superior del balón respecto al borde superior de la fila.
      const above = -(ty + ORIGIN - s * (ORIGIN - BALL_TOP_IN_CANVAS));
      if (above > worst.above) worst = { above, sport, percent: percent.trim() };
    }
  }

  assert.ok(
    worst.above < headroom,
    `${worst.sport} sube ${worst.above.toFixed(3)} filas en ${worst.percent} y el recorte está a ${headroom.toFixed(3)}`,
  );
});

test('la secuencia termina en fila, desplaza los balones desde el casco y barre un brillo', () => {
  const styles = read('app/globals.css');
  assert.match(styles, /@keyframes appleSportFootball[\s\S]*left: 87\.5%[\s\S]*left: 12\.5%/);
  assert.match(styles, /@keyframes appleSportBaseball[\s\S]*left: 87\.5%[\s\S]*left: 37\.5%/);
  assert.match(styles, /@keyframes appleSportBasketball[\s\S]*left: 87\.5%[\s\S]*left: 62\.5%/);
  assert.match(styles, /@keyframes appleSportHelmet[\s\S]*left: 87\.5%/);
  assert.match(styles, /@keyframes appleSportsShine/);
  assert.match(styles, /mask: url\('\/sports-sequence\/lineup-mask\.webp'\)/);
});

test('el relevo se solapa: el siguiente entra mientras el anterior aún se ve', () => {
  const styles = read('app/globals.css');
  const relay = [
    ['appleSportFootball', 'appleSportBaseball'],
    ['appleSportBaseball', 'appleSportBasketball'],
    ['appleSportBasketball', 'appleSportHelmet'],
  ];

  for (const [outgoing, incoming] of relay) {
    const salida = opacityStops(keyframesOf(styles, outgoing));
    const entrada = opacityStops(keyframesOf(styles, incoming));

    // Primer paso en el que el saliente vuelve a opacidad 0 tras haberse visto.
    const visible = salida.findIndex((stop) => stop.opacity === 1);
    const desaparece = salida.slice(visible).find((stop) => stop.opacity === 0);
    // Primer paso en el que el entrante ya es opaco.
    const aparece = entrada.find((stop) => stop.opacity === 1);

    assert.ok(desaparece && aparece, `${outgoing} → ${incoming} sin pasos de opacidad`);
    assert.ok(
      aparece.percent < desaparece.percent,
      `${incoming} entra en ${aparece.percent}% pero ${outgoing} ya se fue en ${desaparece.percent}%`,
    );
  }
});

test('el brillo recorre la fila entera de derecha a izquierda', () => {
  const styles = read('app/globals.css');
  const shine = keyframesOf(styles, 'appleSportsShine');
  const positions = [...shine.matchAll(/background-position:\s*(-?[\d.]+)%/g)].map((m) => Number.parseFloat(m[1]));

  assert.ok(positions[0] > 100, 'el brillo debe arrancar fuera del borde derecho');
  assert.ok(positions.at(-1) < 0, 'el brillo debe terminar fuera del borde izquierdo');
  // Velocidad constante: si no, el primer o el último objeto se queda sin destello.
  assert.match(styles, /animation: appleSportsShine [\d.]+s linear both/);
});

// La hoja tiene muchos bloques prefers-reduced-motion; devuelve solo el que
// apaga la secuencia, con sus llaves equilibradas.
const reducedMotionBlockFor = (styles, marker) => {
  const anchor = styles.indexOf(marker);
  assert.ok(anchor >= 0, `no aparece ${marker}`);
  const start = styles.lastIndexOf('@media (prefers-reduced-motion: reduce) {', anchor);
  assert.ok(start >= 0, `${marker} no está dentro de un bloque de movimiento reducido`);

  let depth = 0;
  for (let index = styles.indexOf('{', start); index < styles.length; index += 1) {
    if (styles[index] === '{') depth += 1;
    else if (styles[index] === '}') {
      depth -= 1;
      if (depth === 0) return styles.slice(start, index + 1);
    }
  }
  throw new Error('bloque de movimiento reducido sin cerrar');
};

test('movimiento reducido muestra la fila final sin animación', () => {
  const styles = read('app/globals.css');
  const reduced = reducedMotionBlockFor(styles, '.apple-sports-shine { display: none; }');

  // El reset tiene que igualar la especificidad de las reglas por deporte
  // (.apple-hero-scene.is-active .apple-sport-object.is-x), si no, no las apaga.
  for (const sport of SPORTS) {
    assert.match(
      reduced,
      new RegExp(`\\.apple-hero-scene\\.is-active \\.apple-sport-object\\.is-${sport}`),
      `el reset de movimiento reducido no alcanza a .is-${sport}`,
    );
  }
  assert.match(reduced, /\.apple-sport-object\.is-football \{ left: 12\.5%; \}/);
  assert.match(reduced, /\.apple-sports-shine \{ display: none; \}/);
});

test('los recursos del hero quedan optimizados para la carga inicial', () => {
  const files = [...SPORTS.map((sport) => `${sport}.webp`), 'lineup-mask.webp'];
  const totalBytes = files.reduce((total, file) => total + fs.statSync(path.join(root, 'public/sports-sequence', file)).size, 0);
  assert.ok(totalBytes < 250 * 1024, `Los recursos pesan ${Math.round(totalBytes / 1024)} KB`);
});
