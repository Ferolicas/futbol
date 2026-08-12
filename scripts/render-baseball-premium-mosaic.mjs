#!/usr/bin/env node

import sharp from 'sharp';
import { renderBaseballPremiumMosaicPng } from '../lib/baseball-premium-mosaic-image.js';

// El proceso es efimero, por lo que una cache nativa no aporta reutilizacion y
// solo aumenta el pico de memoria. Un unico hilo mantiene el consumo acotado.
sharp.cache(false);
sharp.concurrency(1);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const png = await renderBaseballPremiumMosaicPng(payload);
  await new Promise((resolve, reject) => {
    process.stdout.write(png, (error) => (error ? reject(error) : resolve()));
  });
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
