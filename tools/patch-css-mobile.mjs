import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/web/src/styles.css'
const text = readFileSync(file, 'utf8')

const bad = `/* 手机 / 平板竖屏：单列布局，工作台变成整屏抽屉，顶部菜单交给悬浮球 */
@media (max-width: 820px) {
  .shell > .frame {
    grid-template-columns: 1fr;
  }

  .sidebarCol {
    display: none;
  }

  .dock {`

const good = `/* 手机 / 平板竖屏：工作台铺满，顶部菜单交给悬浮球。
   栅格保持两列（侧栏能自己收窄）；把列改成 1fr 会让侧栏和对话变成上下两行。 */
@media (max-width: 820px) {
  .dock {`

if (!text.includes(bad)) throw new Error('pattern missing')
writeFileSync(file, text.replace(bad, good), 'utf8')
console.log('css adjusted')
