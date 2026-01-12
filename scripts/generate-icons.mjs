import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const resourcesDir = join(rootDir, 'resources');
const buildDir = join(rootDir, 'build');

// Ensure build directory exists
if (!existsSync(buildDir)) {
  mkdirSync(buildDir, { recursive: true });
}

const pngPath = join(resourcesDir, 'icon.png');
const pngContent = readFileSync(pngPath);

// Generate PNG at various sizes for .ico
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

async function generateIcons() {
  console.log('Generating icon PNGs...');

  // Generate main PNG for Linux (512x512)
  await sharp(pngContent)
    .resize(512, 512)
    .png()
    .toFile(join(buildDir, 'icon.png'));
  console.log('Generated build/icon.png (512x512)');

  // Generate multiple sizes for .ico
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const iconBuffers = [];

  for (const size of icoSizes) {
    const buffer = await sharp(pngContent)
      .resize(size, size)
      .png()
      .toBuffer();
    iconBuffers.push({ size, buffer });
    console.log(`Generated ${size}x${size} PNG for ICO`);
  }

  // Create ICO file (simple implementation)
  const icoBuffer = createIco(iconBuffers);
  writeFileSync(join(buildDir, 'icon.ico'), icoBuffer);
  console.log('Generated build/icon.ico');

  // For .icns, we need to create iconset folder and use iconutil (macOS only)
  // Since we're on Windows, we'll create a simple .icns placeholder
  // The actual .icns should be generated on macOS or using a cross-platform tool

  // Generate PNGs for macOS iconset (can be converted to .icns on Mac)
  const icnsDir = join(buildDir, 'icon.iconset');
  if (!existsSync(icnsDir)) {
    mkdirSync(icnsDir, { recursive: true });
  }

  const icnsSizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ];

  for (const { size, name } of icnsSizes) {
    await sharp(pngContent)
      .resize(size, size)
      .png()
      .toFile(join(icnsDir, name));
  }
  console.log('Generated iconset PNGs in build/icon.iconset/');

  // Try to use png2icns if available, otherwise keep the old .icns
  console.log('Note: .icns file should be generated on macOS using:');
  console.log('  iconutil -c icns build/icon.iconset -o build/icon.icns');

  console.log('\nIcon generation complete!');
}

// Simple ICO file generator
function createIco(images) {
  // ICO format: header + directory entries + image data
  const numImages = images.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;

  // Calculate offsets
  let offset = headerSize + dirSize;
  const imageOffsets = [];
  for (const img of images) {
    imageOffsets.push(offset);
    offset += img.buffer.length;
  }

  // Create buffer
  const totalSize = offset;
  const buffer = Buffer.alloc(totalSize);

  // Write header
  buffer.writeUInt16LE(0, 0); // Reserved
  buffer.writeUInt16LE(1, 2); // Type: 1 = ICO
  buffer.writeUInt16LE(numImages, 4); // Number of images

  // Write directory entries
  let dirOffset = headerSize;
  for (let i = 0; i < numImages; i++) {
    const img = images[i];
    const size = img.size === 256 ? 0 : img.size; // 0 means 256

    buffer.writeUInt8(size, dirOffset); // Width
    buffer.writeUInt8(size, dirOffset + 1); // Height
    buffer.writeUInt8(0, dirOffset + 2); // Color palette
    buffer.writeUInt8(0, dirOffset + 3); // Reserved
    buffer.writeUInt16LE(1, dirOffset + 4); // Color planes
    buffer.writeUInt16LE(32, dirOffset + 6); // Bits per pixel
    buffer.writeUInt32LE(img.buffer.length, dirOffset + 8); // Image size
    buffer.writeUInt32LE(imageOffsets[i], dirOffset + 12); // Offset

    dirOffset += dirEntrySize;
  }

  // Write image data
  for (let i = 0; i < numImages; i++) {
    images[i].buffer.copy(buffer, imageOffsets[i]);
  }

  return buffer;
}

generateIcons().catch(console.error);
