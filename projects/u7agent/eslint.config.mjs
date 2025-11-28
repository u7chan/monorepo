import nextPlugin from 'eslint-config-next'
import { defineConfig } from 'eslint/config'

const eslintConfig = defineConfig([
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
  },
  ...nextPlugin
])

export default eslintConfig
