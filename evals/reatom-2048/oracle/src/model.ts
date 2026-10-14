import { action, atom, reatomEnum } from '@reatom/core'

export const SIZE = 4
const WIN_TILE = 2048
const SPAWN_TWO_PROBABILITY = 0.9

export type Dir = 'left' | 'right' | 'up' | 'down'

const emptyGrid = (): number[][] =>
  Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0))

export const board = atom(emptyGrid(), 'game.board')
export const score = atom(0, 'game.score')
export const status = reatomEnum(['idle', 'playing', 'won', 'lost'], 'game.status')

const cloneGrid = (grid: number[][]): number[][] => grid.map((row) => row.slice())

const sameGrid = (left: number[][], right: number[][]): boolean =>
  left.every((row, rowIndex) => row.every((value, colIndex) => value === right[rowIndex]![colIndex]))

const slideTowardStart = (line: readonly number[]): { line: number[]; gained: number } => {
  const tiles = line.filter((value) => value !== 0)
  const merged: number[] = []
  let gained = 0
  for (let index = 0; index < tiles.length; index++) {
    const current = tiles[index]!
    if (index + 1 < tiles.length && tiles[index + 1] === current) {
      const mergedValue = current * 2
      merged.push(mergedValue)
      gained += mergedValue
      index += 1
    } else {
      merged.push(current)
    }
  }
  while (merged.length < SIZE) merged.push(0)
  return { line: merged, gained }
}

const readLine = (grid: number[][], dir: Dir, index: number): number[] => {
  if (dir === 'left' || dir === 'right') {
    const row = grid[index]!.slice()
    return dir === 'right' ? row.reverse() : row
  }
  const column = [grid[0]![index]!, grid[1]![index]!, grid[2]![index]!, grid[3]![index]!]
  return dir === 'down' ? column.reverse() : column
}

const writeLine = (grid: number[][], dir: Dir, index: number, line: number[]) => {
  const oriented = dir === 'right' || dir === 'down' ? line.slice().reverse() : line
  if (dir === 'left' || dir === 'right') {
    grid[index] = oriented
    return
  }
  for (let row = 0; row < SIZE; row++) grid[row]![index] = oriented[row]!
}

const hasWon = (grid: number[][]): boolean =>
  grid.some((row) => row.some((value) => value >= WIN_TILE))

export const hasMoves = (grid: number[][]): boolean => {
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const value = grid[row]![col]!
      if (value === 0) return true
      if (col + 1 < SIZE && grid[row]![col + 1] === value) return true
      if (row + 1 < SIZE && grid[row + 1]![col] === value) return true
    }
  }
  return false
}

const refreshStatus = () => {
  const grid = board()
  if (hasWon(grid)) {
    status.setWon()
    return
  }
  if (!hasMoves(grid)) {
    status.setLost()
    return
  }
  status.setPlaying()
}

const emptyCells = (grid: number[][]): Array<[number, number]> => {
  const cells: Array<[number, number]> = []
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (grid[row]![col] === 0) cells.push([row, col])
    }
  }
  return cells
}

export const spawnRandom = action(() => {
  const grid = cloneGrid(board())
  const cells = emptyCells(grid)
  if (cells.length === 0) {
    refreshStatus()
    return
  }
  const [row, col] = cells[Math.floor(Math.random() * cells.length)]!
  grid[row]![col] = Math.random() < SPAWN_TWO_PROBABILITY ? 2 : 4
  board.set(grid)
  refreshStatus()
}, 'game.spawnRandom')

export const spawnAt = action((row: number, col: number, value: 2 | 4) => {
  const grid = cloneGrid(board())
  grid[row]![col] = value
  board.set(grid)
  refreshStatus()
}, 'game.spawnAt')

export const setBoard = action((grid: number[][]) => {
  board.set(cloneGrid(grid))
  refreshStatus()
}, 'game.setBoard')

export const setScore = action((value: number) => {
  score.set(value)
}, 'game.setScore')

export const move = action((dir: Dir): boolean => {
  if (status() === 'lost') return false
  const next = cloneGrid(board())
  let gained = 0
  for (let index = 0; index < SIZE; index++) {
    const slid = slideTowardStart(readLine(next, dir, index))
    gained += slid.gained
    writeLine(next, dir, index, slid.line)
  }
  if (sameGrid(board(), next)) return false
  board.set(next)
  if (gained > 0) score.set((current) => current + gained)
  refreshStatus()
  return true
}, 'game.move')

export const play = action((dir: Dir): boolean => {
  const changed = move(dir)
  if (changed) spawnRandom()
  return changed
}, 'game.play')

export const newGame = action(() => {
  board.set(emptyGrid())
  score.set(0)
  status.setPlaying()
  spawnRandom()
  spawnRandom()
}, 'game.newGame')
