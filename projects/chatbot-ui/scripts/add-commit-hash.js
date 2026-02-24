import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const libDir = path.resolve('./dist')
const indexFilePath = path.join(libDir, 'index.js')

async function generateIndex() {
  try {
    // git commit hashを取得
    const commitHash = execSync('git rev-parse --short HEAD').toString().trim()

    // 既存のindex.jsの内容を読み取り
    let existingContent = ''
    if (fs.existsSync(indexFilePath)) {
      existingContent = await fs.promises.readFile(indexFilePath, 'utf8')
    }

    // コミットハッシュコメントが既に存在するかチェック
    const commitHashPattern = /^\/\/ Build commit hash:/m

    if (commitHashPattern.test(existingContent)) {
      // 既存のコミットハッシュコメントを新しいものに置き換え
      const updatedContent = existingContent.replace(
        /^\/\/ Build commit hash: .+$/m,
        `// Build commit hash: ${commitHash}`,
      )
      await fs.promises.writeFile(indexFilePath, updatedContent, 'utf8')
      console.log('✅ Successfully updated commit hash in dist/index.js')
      console.log(`Updated commit hash: ${commitHash}`)
    } else {
      // コミットハッシュコメントを先頭に追加
      const result = `// Build commit hash: ${commitHash}\n${existingContent}`
      await fs.promises.writeFile(indexFilePath, result, 'utf8')
      console.log('✅ Successfully added commit hash to dist/index.js')
      console.log(`Added commit hash: ${commitHash}`)
    }
  } catch (error) {
    console.error('❌ Error updating index.js:', error)
    process.exit(1)
  }
}

generateIndex()
