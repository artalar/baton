import { effect, onEvent } from '@reatom/core'
import { h, mount } from '@reatom/jsx'
import { App } from './ui'
import { newGame, play, redo, status, undo, type Dir } from './model'

const arrowDirs: Record<string, Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

const onKeyDown = (event: Event) => {
  const keyEvent = event as KeyboardEvent
  if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) return
  if (keyEvent.code === 'KeyN') {
    keyEvent.preventDefault()
    newGame()
    return
  }
  if (keyEvent.code === 'KeyU') {
    keyEvent.preventDefault()
    undo()
    return
  }
  if (keyEvent.code === 'KeyR') {
    keyEvent.preventDefault()
    redo()
    return
  }
  const dir = arrowDirs[keyEvent.key]
  if (!dir) return
  keyEvent.preventDefault()
  play(dir)
}

if (status() === 'idle') newGame()

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')
const { unmount } = mount(root, <App />)

const keyboard = effect(() => {
  onEvent(document, 'keydown', onKeyDown)
}, 'game.keyboard')

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    keyboard.unsubscribe()
    unmount()
  })
}
