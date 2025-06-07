import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const libDir = path.resolve('./lib');
const indexFilePath = path.join(libDir, 'index.js');

async function generateIndex() {
  try {
    // git commit hashを取得
    const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

    const files = await fs.promises.readdir(libDir);
    const jsFiles = files.filter(f => f.endsWith('.js') && f !== 'index.js');

    const exports = jsFiles.map(file => {
      const basename = path.basename(file, '.js');
      return `export { default as ${basename} } from './${file}';`;
    }).join('\n');

    // 先頭にコメントを追加
    const result = `// Build commit hash: ${commitHash}\n${exports}\n`;

    await fs.promises.writeFile(indexFilePath, result, 'utf8');
    console.log('Successfully generated lib/index.js:');
    console.log(result);
  } catch (error) {
    console.error('Error generating index.js:', error);
    process.exit(1);
  }
}

generateIndex();