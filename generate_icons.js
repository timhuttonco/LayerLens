/**
 * Run once with: node generate_icons.js
 * Requires the 'canvas' npm package: npm install canvas
 * Or just replace icons/ with any PNG files you like.
 */
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#4f46e5');
  grad.addColorStop(1, '#7c3aed');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, size, size, size * 0.18);
  ctx.fill();

  // Magnifying glass
  const cx = size * 0.42, cy = size * 0.42, r = size * 0.22;
  const lw = Math.max(1, size * 0.08);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const angle = Math.PI / 4;
  ctx.beginPath();
  ctx.moveTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  ctx.lineTo(cx + r * Math.cos(angle) + size * 0.2, cy + r * Math.sin(angle) + size * 0.2);
  ctx.stroke();

  const out = path.join(__dirname, 'icons', `icon${size}.png`);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`Written ${out}`);
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
