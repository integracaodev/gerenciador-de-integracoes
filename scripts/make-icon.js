const fs = require('fs');
const path = require('path');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const inputPng = path.join(projectRoot, 'newlogo.png');
  const outIco = path.join(projectRoot, 'app-icon.ico');

  if (!fs.existsSync(inputPng)) {
    console.error(`[icon] Arquivo não encontrado: ${inputPng}`);
    process.exit(1);
  }

  // Lazy-load deps so "npm start" doesn't require them unless needed
  const sharp = require('sharp');
  const toIco = require('to-ico');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const size of sizes) {
    const buf = await sharp(inputPng)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push(buf);
  }

  const icoBuf = await toIco(pngBuffers);
  fs.writeFileSync(outIco, icoBuf);
  console.log(`[icon] ICO gerado com sucesso: ${outIco}`);
}

main().catch((err) => {
  console.error('[icon] Erro ao gerar ICO:', err?.message || err);
  process.exit(1);
});

