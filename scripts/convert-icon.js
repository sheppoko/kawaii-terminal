const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '../assets/icon-neon.svg');
const outputDir = path.join(__dirname, '../assets');
const buildDir = path.join(__dirname, '../build');

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

async function convert() {
  const pngToIco = (await import('png-to-ico')).default;
  const svgBuffer = fs.readFileSync(svgPath);

  // Generate PNGs at various sizes
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(outputDir, `icon-${size}.png`));
    console.log(`Generated icon-${size}.png`);
  }

  // Main icon for Electron (1024x1024)
  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(outputDir, 'icon.png'));
  console.log('Generated icon.png (1024x1024)');

  // Generate .ico for Windows
  const icoSizes = [16, 32, 48, 256];
  const pngFiles = icoSizes.map(s => path.join(outputDir, `icon-${s}.png`));
  const ico = await pngToIco(pngFiles);
  fs.writeFileSync(path.join(outputDir, 'icon.ico'), ico);
  console.log('Generated icon.ico');

  // Copy build resources for electron-builder (uses build/ by default)
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(path.join(outputDir, 'icon.png'), path.join(buildDir, 'icon.png'));
  fs.copyFileSync(path.join(outputDir, 'icon.ico'), path.join(buildDir, 'icon.ico'));
  console.log('Copied icon.png/icon.ico to build/');

  console.log('Done!');
}

convert().catch(console.error);
