// 让 Node 能直接跑 src 下的 TypeScript：补 @/ 别名与省略的 .ts 扩展名。
// 只用于本地校验脚本，不参与前端构建。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = join(sourceRoot, specifier.slice(2))
    return nextResolve(pathToFileURL(existsSync(target) ? target : `${target}.ts`).href, context)
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.endsWith('.ts')
  ) {
    const target = join(dirname(fileURLToPath(context.parentURL)), specifier)
    if (!existsSync(target) && existsSync(`${target}.ts`)) {
      return nextResolve(pathToFileURL(`${target}.ts`).href, context)
    }
  }
  return nextResolve(specifier, context)
}
