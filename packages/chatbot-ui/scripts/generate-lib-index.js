import fs from 'node:fs';
import path from 'node:path';

const libDir = path.resolve('./lib');
const indexFilePath = path.join(libDir, 'index.js');

async function generateIndex() {
  try {
    const files = await fs.promises.readdir(libDir);
    const jsFiles = files.filter(f => f.endsWith('.js') && f !== 'index.js');

        const exports = `${jsFiles.map(file => {
          const basename = path.basename(file, '.js');
          return `export { default as ${basename} } from './${file}';`;
        }).join('\n')}
    `;

    const cleanedExports = `${exports.trimEnd()}\n`;

    await fs.promises.writeFile(indexFilePath, cleanedExports, 'utf8');
    console.log('Successfully generated lib/index.js:');
    console.log(cleanedExports);
  } catch (error) {
    console.error('Error generating index.js:', error);
    process.exit(1);
  }
}

generateIndex();