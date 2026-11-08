// Validate the tour against the actual wall builder; run: node scripts/check-landing-path.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as THREE from 'three';
const packageRequire = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
function load(relative) {
  const file = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const record = { exports: {} };
  const localRequire = name => name === 'three' ? THREE : name === '@/lib/sample-layout.json' ? packageRequire('../src/lib/sample-layout.json') : name === '@/lib/walls' ? load('src/lib/walls.ts') : packageRequire(name);
  vm.runInNewContext(code, { exports: record.exports, module: record, require: localRequire });
  return record.exports;
}
const { cameraAt, walls } = load('src/components/landing/geometry.ts');
for (let i = 0; i <= 4000; i++) {
  const { position } = cameraAt(i / 4000);
  assert(Number.isFinite(position.x + position.y + position.z));
  if (position.y > 9.4) continue;
  for (const wall of walls) {
    const margin = 0.4;
    const inside = position.x > Math.min(wall.x1, wall.x2) - margin && position.x < Math.max(wall.x1, wall.x2) + margin && position.z > Math.min(wall.y1, wall.y2) - margin && position.z < Math.max(wall.y1, wall.y2) + margin;
    assert(!inside, `Camera intersects wall at progress ${i / 4000}`);
  }
  if (i >= Math.ceil(4000 / 7)) assert(Math.abs(position.y - 5.5) < 0.001, 'Interior eye height must be 5.5 feet');
}
console.log('PASS: 4,001 camera samples clear walls with 0.4 ft clearance; interior eye height 5.5 ft.');
