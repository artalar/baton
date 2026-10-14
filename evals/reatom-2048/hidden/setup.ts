import { addGlobalExtension, isAction, isAtom } from '@reatom/core'

type Status = 'idle' | 'playing' | 'won' | 'lost'
type Dir = 'left' | 'right' | 'up' | 'down'
type Target = ((...args: unknown[]) => unknown) & {
  name?: string
  __reatom?: { name?: string }
  set?: (value: unknown) => void
  [key: string]: unknown
}

const atoms = new Map<string, Target>()
const actions = new Map<string, Target>()

const targetName = (target: Target) =>
  String(target.name ?? target.__reatom?.name ?? '')

const lastSegment = (name: string) => {
  const base = name.split('#')[0] ?? name
  const parts = base.split('.')
  return (parts[parts.length - 1] ?? base).toLowerCase()
}

const pick = (
  registry: Map<string, Target>,
  aliases: string[],
  exclude: string[] = [],
) => {
  const wanted = aliases.map((alias) => alias.toLowerCase())
  const blocked = exclude.map((alias) => alias.toLowerCase())
  const entries = [...registry.entries()]
  const segmentBlocked = (segment: string) => blocked.includes(segment)

  for (const alias of wanted) {
    for (const [name, target] of entries) {
      if (name.toLowerCase() === alias) return target
    }
  }
  for (const alias of wanted) {
    for (const [name, target] of entries) {
      const segment = lastSegment(name)
      if (segmentBlocked(segment)) continue
      if (segment === alias) return target
    }
  }
  for (const alias of wanted) {
    for (const [name, target] of entries) {
      const segment = lastSegment(name)
      if (segmentBlocked(segment)) continue
      if (name.toLowerCase().includes(alias)) return target
    }
  }
}

addGlobalExtension((target) => {
  const name = targetName(target as Target)
  if (!name) return target
  if (isAction(target)) actions.set(name, target as Target)
  else if (isAtom(target)) atoms.set(name, target as Target)
  return target
})

const cloneGrid = (grid: number[][]) => grid.map((row) => row.slice())

const asGrid = (value: unknown): number[][] => {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((row) => !Array.isArray(row) || row.length !== 4)
  ) {
    throw new Error('expected a 4x4 board atom')
  }
  return cloneGrid(value as number[][])
}

const hasWon = (grid: number[][]) =>
  grid.some((row) => row.some((value) => value >= 2048))

const hasMoves = (grid: number[][]) => {
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const value = grid[row]![col]!
      if (value === 0) return true
      if (col + 1 < 4 && grid[row]![col + 1] === value) return true
      if (row + 1 < 4 && grid[row + 1]![col] === value) return true
    }
  }
  return false
}

const statusFrom = (grid: number[][]): Status => {
  if (hasWon(grid)) return 'won'
  if (!hasMoves(grid)) return 'lost'
  return 'playing'
}

const requireTarget = (registry: Map<string, Target>, aliases: string[], exclude?: string[]) => {
  const found = pick(registry, aliases, exclude)
  if (!found) throw new Error(`missing Reatom name: ${aliases.join('|')}`)
  return found
}

const writeStatus = (next: Status) => {
  const status = pick(atoms, ['status', 'phase'])
  if (!status) return
  const method = {
    idle: 'setIdle',
    playing: 'setPlaying',
    won: 'setWon',
    lost: 'setLost',
  }[next]
  const setter = status[method]
  if (typeof setter === 'function') {
    setter()
    return
  }
  if (typeof status.set === 'function') status.set(next)
}

const writeBoard = (grid: number[][]) => {
  const next = cloneGrid(grid)
  const board = pick(atoms, ['board', 'grid', 'tiles'])
  if (typeof board?.set === 'function') board.set(next)
  else {
    const setBoard = pick(actions, ['setBoard'])
    if (typeof setBoard !== 'function') {
      if (!board) throw new Error('missing Reatom name: board|grid|tiles')
      throw new Error('board is not writable')
    }
    setBoard(next)
  }
  writeStatus(statusFrom(next))
}

window.__eval = {
  getBoard: () => asGrid(requireTarget(atoms, ['board', 'grid', 'tiles'])()),
  setBoard: (grid: number[][]) => {
    writeBoard(grid)
  },
  getScore: () => Number(requireTarget(atoms, ['score', 'points'])()),
  setScore: (value: number) => {
    const score = pick(atoms, ['score', 'points'])
    if (typeof score?.set === 'function') {
      score.set(value)
      return
    }
    const setScore = pick(actions, ['setScore'])
    if (typeof setScore === 'function') {
      setScore(value)
      return
    }
    if (!score) throw new Error('missing Reatom name: score|points')
    throw new Error('score is not writable')
  },
  getStatus: () => requireTarget(atoms, ['status', 'phase'])() as Status,
  move: (dir: Dir) => {
    const move = requireTarget(actions, ['move', 'slide'], ['play', 'spawn'])
    return Boolean(move(dir))
  },
  spawnAt: (row: number, col: number, value: 2 | 4) => {
    const board = asGrid(requireTarget(atoms, ['board', 'grid', 'tiles'])())
    board[row]![col] = value
    writeBoard(board)
  },
  newGame: () => {
    const newGame = requireTarget(actions, ['newgame', 'restart'])
    newGame()
  },
}

declare global {
  interface Window {
    __eval: {
      getBoard: () => number[][]
      setBoard: (grid: number[][]) => void
      getScore: () => number
      setScore: (value: number) => void
      getStatus: () => Status
      move: (dir: Dir) => boolean
      spawnAt: (row: number, col: number, value: 2 | 4) => void
      newGame: () => void
    }
  }
}
