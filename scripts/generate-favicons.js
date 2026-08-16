import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const svgPath = path.resolve('../frontend/public/favicon.svg');
const publicDir = path.resolve('../frontend/public');

async function generate() {
  console.log('Generating favicon assets from:', svgPath);
  const svgBuffer = fs.readFileSync(svgPath);

  const sizes = [
    { name: 'favicon-16x16.png', size: 16 },
    { name: 'favicon-32x32.png', size: 32 },
    { name: 'favicon-48x48.png', size: 48 }, // Google's primary favicon target
    { name: 'favicon-96x96.png', size: 96 },
    { name: 'apple-touch-icon.png', size: 180 },
    { name: 'android-chrome-192x192.png', size: 192 },
    { name: 'android-chrome-512x512.png', size: 512 },
  ];

  const icoBuffers = [];

  for (const item of sizes) {
    const outPath = path.join(publicDir, item.name);
    const buf = await sharp(svgBuffer)
      .resize(item.size, item.size)
      .png()
      .toBuffer();
    fs.writeFileSync(outPath, buf);
    console.log(`✓ Generated ${item.name} (${item.size}x${item.size})`);

    if ([16, 32, 48].includes(item.size)) {
      icoBuffers.push({ width: item.size, height: item.size, buffer: buf });
    }
  }

  // Create favicon.ico
  const count = icoBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const item of icoBuffers) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += item.buffer.length;
  }

  const icoFileBuffer = Buffer.concat([header, ...dirEntries, ...icoBuffers.map(b => b.buffer)]);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoFileBuffer);
  console.log('✓ Generated favicon.ico (16x16, 32x32, 48x48)');

  // Generate og-image.png (1200x630) social preview card
  const ogSvg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f0717" />
          <stop offset="50%" stop-color="#210b33" />
          <stop offset="100%" stop-color="#0a0310" />
        </linearGradient>
        <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7c3aed" />
          <stop offset="100%" stop-color="#4f177a" />
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#bgGrad)" />
      <circle cx="600" cy="220" r="180" fill="#7c3aed" opacity="0.15" filter="blur(60px)" />
      
      <!-- Center Logo Box -->
      <g transform="translate(536, 120)">
        <rect width="128" height="128" rx="32" fill="url(#logoGrad)" />
        <text x="64" y="76" fill="#ffffff" font-size="68" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif">W</text>
      </g>
      
      <!-- Title -->
      <text x="600" y="320" fill="#ffffff" font-size="46" font-weight="800" text-anchor="middle" font-family="Arial, sans-serif" letter-spacing="2">WATCHIN IT</text>
      
      <!-- Subtitle -->
      <text x="600" y="380" fill="#c084fc" font-size="22" font-weight="600" text-anchor="middle" font-family="Arial, sans-serif">A streaming &amp; networking platform for independent filmmakers</text>
      <text x="600" y="420" fill="#94a3b8" font-size="18" font-weight="400" text-anchor="middle" font-family="Arial, sans-serif">Bringing all the cinephiles under one roof</text>
      
      <!-- URL pill -->
      <g transform="translate(480, 480)">
        <rect width="240" height="42" rx="21" fill="#7c3aed" opacity="0.2" stroke="#a855f7" stroke-width="1.5" />
        <text x="120" y="27" fill="#e9d5ff" font-size="16" font-weight="600" text-anchor="middle" font-family="Arial, sans-serif">watchinit.com</text>
      </g>
    </svg>
  `;
  const ogBuffer = await sharp(Buffer.from(ogSvg)).png().toBuffer();
  fs.writeFileSync(path.join(publicDir, 'og-image.png'), ogBuffer);
  console.log('✓ Generated og-image.png (1200x630)');

  console.log('\nAll assets generated successfully!');
}

generate().catch(err => {
  console.error('Error generating assets:', err);
  process.exit(1);
});
