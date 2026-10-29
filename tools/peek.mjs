import { readFileSync } from 'node:fs'

const lines = readFileSync('packages/bridge/src/session.mjs', 'utf8').split(/\r?\n/)
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])]
const masked = lines
  .slice(from - 1, to)
  .map((line) => line.replace(/((?:apiKey|authToken|token|secret|password)\s*:\s*)(['"])(?:.*?)\2/gi, '$1$2***$2'))
  .join('\n')
console.log(masked)
