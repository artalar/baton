import { expect, test, type Page } from '@playwright/test'

type Status = 'idle' | 'playing' | 'won' | 'lost'
type Dir = 'left' | 'right' | 'up' | 'down'
type BoardProbe = { ok: boolean; ready: boolean; error: string }

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

const cellIds = Array.from({ length: 16 }, (_, index) => {
  const row = Math.floor(index / 4)
  const col = index % 4
  return `${row}-${col}`
})

const stuckBoard = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
]

const nearLostBoard = [
  [8, 16, 0, 32],
  [64, 128, 256, 512],
  [8, 16, 32, 64],
  [128, 256, 512, 1024],
]

const dirtyBoard = [
  [2, 4, 8, 16],
  [32, 64, 128, 256],
  [512, 1024, 2, 4],
  [8, 16, 32, 64],
]

const slideRightStart = [
  [2, 0, 0, 2],
  [0, 0, 0, 4],
  [0, 0, 0, 0],
  [8, 8, 8, 8],
]

const slideRightMerged = [
  [0, 0, 0, 4],
  [0, 0, 0, 4],
  [0, 0, 0, 0],
  [0, 0, 16, 16],
]

const packedRight = [
  [0, 0, 0, 2],
  [0, 0, 0, 4],
  [0, 0, 0, 8],
  [0, 0, 0, 16],
]

async function open(page: Page) {
  await page.goto('/')
  const deadline = Date.now() + 5_000
  let lastError = 'window.__eval is missing'
  while (Date.now() <= deadline) {
    let probe: BoardProbe
    try {
      probe = await page.evaluate((): BoardProbe => {
        const hook = window.__eval
        if (!hook || typeof hook.getBoard !== 'function') {
          return { ok: false, ready: false, error: 'window.__eval is missing' }
        }
        try {
          const board = hook.getBoard()
          if (Array.isArray(board)) return { ok: true, ready: true, error: '' }
          return { ok: false, ready: true, error: 'expected a 4x4 board atom' }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, ready: true, error: message }
        }
      })
    } catch (error) {
      probe = {
        ok: false,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (probe.ok) return
    lastError = probe.error
    if (probe.ready) throw new Error(lastError)
    await page.waitForTimeout(50)
  }
  throw new Error(lastError)
}

async function setGrid(page: Page, grid: number[][], scoreValue = 0) {
  await page.evaluate(
    ({ grid, scoreValue }) => {
      window.__eval.setScore(scoreValue)
      window.__eval.setBoard(grid)
    },
    { grid, scoreValue },
  )
}

async function readState(page: Page) {
  return page.evaluate(() => ({
    board: window.__eval.getBoard(),
    score: window.__eval.getScore(),
    status: window.__eval.getStatus(),
  }))
}

async function expectDom(page: Page) {
  const snapshot = await page.evaluate(() => {
    const board = window.__eval.getBoard()
    const cells = []
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const element = document.querySelector(`[data-cell="${row}-${col}"]`)
        cells.push({
          id: `${row}-${col}`,
          value: board[row]![col]!,
          text: (element?.textContent ?? '').trim(),
          insideBoard: Boolean(element?.closest('[data-board]')),
        })
      }
    }
    return {
      cells,
      cellCount: document.querySelectorAll('[data-cell]').length,
      scoreText: (document.querySelector('[data-score]')?.textContent ?? '').trim(),
      score: window.__eval.getScore(),
      statusAttr: document.querySelector('[data-status]')?.getAttribute('data-status'),
      status: window.__eval.getStatus(),
    }
  })

  expect(snapshot.cellCount).toBe(16)
  expect(snapshot.scoreText).toBe(String(snapshot.score))
  expect(snapshot.statusAttr).toBe(snapshot.status)
  for (const cell of snapshot.cells) {
    expect(cell).toEqual({
      id: cell.id,
      value: cell.value,
      text: cell.value === 0 ? '' : String(cell.value),
      insideBoard: true,
    })
  }
}

function countTiles(board: number[][]) {
  return board.flat().filter((value) => value !== 0)
}

function spawnDelta(before: number[][], after: number[][]) {
  const changes: Array<{ row: number; col: number; from: number; value: number }> = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const from = before[row]![col]!
      const value = after[row]![col]!
      if (from !== value) changes.push({ row, col, from, value })
    }
  }
  return changes
}

async function pressArrow(page: Page, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') {
  await page.evaluate((key) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, key)
}

async function pressLetter(page: Page, letter: 'n' | 'u') {
  await page.evaluate((letter) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: letter,
        code: `Key${letter.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, letter)
}

type ScoreReply = { delayMs?: number; status?: number; networkError?: boolean }

async function mockScores(page: Page, replies: ScoreReply[]) {
  const bodies: unknown[] = []
  await page.route('**/api/scores', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()
    const reply = replies[Math.min(bodies.length, replies.length - 1)] ?? {}
    bodies.push(request.postDataJSON())
    if (reply.delayMs) await new Promise((done) => setTimeout(done, reply.delayMs))
    try {
      if (reply.networkError) await route.abort('failed')
      else {
        await route.fulfill({
          status: reply.status ?? 200,
          contentType: 'application/json',
          body: '{}',
        })
      }
    } catch {
      // The page aborted the request while the reply was delayed.
    }
  })
  return bodies
}

const submitAttr = (page: Page) => page.locator('[data-submit]')

test('startup deals score 0, status playing, and two tiles', async ({ page }) => {
  await open(page)
  const state = await readState(page)
  const tiles = countTiles(state.board)
  expect(state.status).toBe('playing')
  expect(state.score).toBe(0)
  expect(tiles).toHaveLength(2)
  expect(tiles.every((value) => value === 2 || value === 4)).toBe(true)
})

test('eval hook writes the board and spawnAt places one tile', async ({ page }) => {
  await open(page)
  const hook = await page.evaluate(() => ({
    getBoard: typeof window.__eval.getBoard,
    setBoard: typeof window.__eval.setBoard,
    getScore: typeof window.__eval.getScore,
    setScore: typeof window.__eval.setScore,
    getStatus: typeof window.__eval.getStatus,
    move: typeof window.__eval.move,
    spawnAt: typeof window.__eval.spawnAt,
    newGame: typeof window.__eval.newGame,
  }))
  expect(Object.values(hook).every((kind) => kind === 'function')).toBe(true)

  await page.evaluate(() => {
    window.__eval.setBoard([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])
    window.__eval.spawnAt(2, 1, 4)
  })
  const spawned = await readState(page)
  expect(spawned.board[2]![1]).toBe(4)
  expect(countTiles(spawned.board)).toEqual([4])
})

test('move slides and merges without spawning', async ({ page }) => {
  await open(page)
  await setGrid(page, [
    [2, 2, 2, 0],
    [2, 2, 2, 2],
    [4, 4, 2, 2],
    [0, 0, 0, 0],
  ])
  expect(await page.evaluate(() => window.__eval.move('left'))).toBe(true)
  const left = await readState(page)
  expect(left.board).toEqual([
    [4, 2, 0, 0],
    [4, 4, 0, 0],
    [8, 4, 0, 0],
    [0, 0, 0, 0],
  ])
  expect(left.score).toBe(24)

  await setGrid(page, [
    [2, 0, 0, 0],
    [2, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  expect(await page.evaluate(() => window.__eval.move('up'))).toBe(true)
  const up = await readState(page)
  expect(up.board).toEqual([
    [4, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  expect(up.score).toBe(4)

  await setGrid(page, [
    [0, 0, 0, 2],
    [0, 0, 0, 2],
    [0, 0, 0, 2],
    [0, 0, 0, 0],
  ])
  expect(await page.evaluate(() => window.__eval.move('down'))).toBe(true)
  const down = await readState(page)
  expect(down.board).toEqual([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 2],
    [0, 0, 0, 4],
  ])
  expect(down.score).toBe(4)
})

test('no-op move returns false and does not spawn', async ({ page }) => {
  await open(page)
  const packedLeft = [
    [2, 0, 0, 0],
    [4, 0, 0, 0],
    [8, 0, 0, 0],
    [16, 0, 0, 0],
  ]
  await setGrid(page, packedLeft, 7)
  const changed = await page.evaluate(() => window.__eval.move('left'))
  const after = await readState(page)
  expect(changed).toBe(false)
  expect(after.board).toEqual(packedLeft)
  expect(after.score).toBe(7)
  expect(after.status).toBe('playing')
})

test('right move that merges 1024s sets won', async ({ page }) => {
  await open(page)
  await setGrid(page, [
    [0, 0, 1024, 1024],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  expect((await readState(page)).status).toBe('playing')
  expect(await page.evaluate(() => window.__eval.move('right'))).toBe(true)
  const won = await readState(page)
  expect(won.board).toEqual([
    [0, 0, 0, 2048],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  expect(won.score).toBe(2048)
  expect(won.status).toBe('won')
})

test('move continues after win and keeps status won', async ({ page }) => {
  await open(page)
  await setGrid(page, [
    [2048, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  expect(await page.evaluate(() => window.__eval.move('right'))).toBe(true)
  const after = await readState(page)
  expect(after.status).toBe('won')
  expect(after.board).toEqual([
    [0, 0, 0, 2048],
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
})

test('full board with no adjacent equals is lost', async ({ page }) => {
  await open(page)
  await setGrid(page, stuckBoard, 3)
  const lost = await readState(page)
  expect(lost.status).toBe('lost')
  expect(lost.score).toBe(3)
  expect(lost.board).toEqual(stuckBoard)

  for (const dir of ['left', 'right', 'up', 'down'] as const) {
    const changed = await page.evaluate((dir) => window.__eval.move(dir), dir)
    expect(changed).toBe(false)
  }
  expect((await readState(page)).board).toEqual(stuckBoard)
})

test('ArrowLeft into a blocked board spawns once and sets lost', async ({ page }) => {
  await open(page)
  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  const after = await readState(page)
  expect(after.board[0]!.slice(0, 3)).toEqual([8, 16, 32])
  expect(after.board[0]![3] === 2 || after.board[0]![3] === 4).toBe(true)
  expect(after.board.slice(1)).toEqual(nearLostBoard.slice(1))
  expect(after.score).toBe(7)
  expect(after.status).toBe('lost')
})

test('won stays won when a stuck board contains 2048', async ({ page }) => {
  await open(page)
  const board = nearLostBoard.map((row) => row.slice())
  board[3]![3] = 2048
  await setGrid(page, board, 7)
  await pressArrow(page, 'ArrowLeft')
  const after = await readState(page)
  expect(after.board[0]!.slice(0, 3)).toEqual([8, 16, 32])
  expect(after.board[0]![3] === 2 || after.board[0]![3] === 4).toBe(true)
  expect(after.board.slice(1)).toEqual(board.slice(1))
  expect(after.status).toBe('won')
})

test('newGame and the new-game control reset score and deal two tiles', async ({ page }) => {
  await open(page)

  await setGrid(page, dirtyBoard, 40)
  await page.evaluate(() => window.__eval.newGame())
  const fromHook = await readState(page)
  const hookTiles = countTiles(fromHook.board)
  expect(fromHook.score).toBe(0)
  expect(fromHook.status).toBe('playing')
  expect(hookTiles).toHaveLength(2)
  expect(hookTiles.every((value) => value === 2 || value === 4)).toBe(true)

  await setGrid(page, dirtyBoard, 40)
  await page.locator('[data-new-game]').click()
  const fromClick = await readState(page)
  const clickTiles = countTiles(fromClick.board)
  expect(fromClick.score).toBe(0)
  expect(fromClick.status).toBe('playing')
  expect(clickTiles).toHaveLength(2)
  expect(clickTiles.every((value) => value === 2 || value === 4)).toBe(true)
})

test('n key starts a fresh game', async ({ page }) => {
  await open(page)
  await setGrid(page, dirtyBoard, 40)
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        code: 'KeyN',
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  const after = await readState(page)
  const tiles = countTiles(after.board)
  expect(after.score).toBe(0)
  expect(after.status).toBe('playing')
  expect(tiles).toHaveLength(2)
  expect(tiles.every((value) => value === 2 || value === 4)).toBe(true)
})

test('ArrowRight matches move(right) and then spawns one tile', async ({ page }) => {
  await open(page)

  await setGrid(page, slideRightStart, 10)
  expect(await page.evaluate(() => window.__eval.move('right'))).toBe(true)
  const afterMove = await readState(page)
  expect(afterMove.board).toEqual(slideRightMerged)
  expect(afterMove.score).toBe(46)

  await setGrid(page, slideRightStart, 10)
  await pressArrow(page, 'ArrowRight')
  const afterKey = await readState(page)
  expect(afterKey.score).toBe(46)
  const spawned = spawnDelta(slideRightMerged, afterKey.board)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.from).toBe(0)
  expect(spawned[0]?.value === 2 || spawned[0]?.value === 4).toBe(true)

  await setGrid(page, packedRight, 5)
  await pressArrow(page, 'ArrowRight')
  const afterNoop = await readState(page)
  expect(afterNoop.board).toEqual(packedRight)
  expect(afterNoop.score).toBe(5)
})

test('on-screen data-move right matches ArrowRight and spawns one tile', async ({ page }) => {
  await open(page)
  const moves = await page.locator('[data-move]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-move')).sort(),
  )
  expect(moves).toEqual(['down', 'left', 'right', 'up'])

  await setGrid(page, slideRightStart, 10)
  await page.locator('[data-move="right"]').click()
  const afterClick = await readState(page)
  expect(afterClick.score).toBe(46)
  const spawned = spawnDelta(slideRightMerged, afterClick.board)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.from).toBe(0)
  expect(spawned[0]?.value === 2 || spawned[0]?.value === 4).toBe(true)

  await setGrid(page, packedRight, 5)
  await page.locator('[data-move="right"]').click()
  const afterNoop = await readState(page)
  expect(afterNoop.board).toEqual(packedRight)
  expect(afterNoop.score).toBe(5)
})

test('dom mirrors the board, score, and status', async ({ page }) => {
  await open(page)
  await expect(page.locator('[data-cell]')).toHaveCount(16)
  await expect(page.locator('[data-board] [data-cell]')).toHaveCount(16)
  const ids = await page.locator('[data-cell]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-cell')).sort(),
  )
  expect(ids).toEqual([...cellIds].sort())
  await expect(page.locator('[data-new-game]')).toHaveCount(1)
  await expectDom(page)

  await setGrid(page, [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ], 1)
  await page.evaluate(() => window.__eval.move('left'))
  await expectDom(page)

  await setGrid(page, [
    [2048, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ], 8)
  expect((await readState(page)).status).toBe('won')
  await expectDom(page)

  await setGrid(page, stuckBoard, 3)
  expect((await readState(page)).status).toBe('lost')
  await expectDom(page)
})

test('undo restores board, score, and status from before the last player move', async ({ page }) => {
  await mockScores(page, [{}])
  await open(page)
  const undoButton = page.locator('[data-undo]')
  await expect(undoButton).toHaveCount(1)
  await expect(undoButton).toBeDisabled()

  await setGrid(page, slideRightStart, 10)
  await pressArrow(page, 'ArrowRight')
  expect((await readState(page)).score).toBe(46)
  await expect(undoButton).toBeEnabled()
  await undoButton.click()
  expect(await readState(page)).toEqual({ board: slideRightStart, score: 10, status: 'playing' })
  await expect(undoButton).toBeDisabled()

  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  expect((await readState(page)).status).toBe('lost')
  await undoButton.click()
  expect(await readState(page)).toEqual({ board: nearLostBoard, score: 7, status: 'playing' })
})

test('undo keeps the last three player moves and the u key undoes', async ({ page }) => {
  await open(page)
  await setGrid(page, [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ])
  const states = [await readState(page)]
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft'] as const) {
    await pressArrow(page, key)
    const state = await readState(page)
    expect(state.board).not.toEqual(states.at(-1)!.board)
    states.push(state)
  }

  await pressLetter(page, 'u')
  expect(await readState(page)).toEqual(states[3])
  await pressLetter(page, 'u')
  expect(await readState(page)).toEqual(states[2])
  await pressLetter(page, 'u')
  expect(await readState(page)).toEqual(states[1])
  await expect(page.locator('[data-undo]')).toBeDisabled()
  await pressLetter(page, 'u')
  expect(await readState(page)).toEqual(states[1])
})

test('new game clears undo history', async ({ page }) => {
  await open(page)
  await setGrid(page, slideRightStart, 10)
  await pressArrow(page, 'ArrowRight')
  await expect(page.locator('[data-undo]')).toBeEnabled()
  await page.locator('[data-new-game]').click()
  await expect(page.locator('[data-undo]')).toBeDisabled()
  const fresh = await readState(page)
  await pressLetter(page, 'u')
  expect(await readState(page)).toEqual(fresh)
})

test('best score survives undo, reload, and new game', async ({ page }) => {
  await open(page)
  const bestText = page.locator('[data-best]')
  await setGrid(page, slideRightStart, 10)
  await pressArrow(page, 'ArrowRight')
  await expect(bestText).toHaveText('46')
  await page.locator('[data-undo]').click()
  expect((await readState(page)).score).toBe(10)
  await expect(bestText).toHaveText('46')

  await page.reload()
  await open(page)
  expect((await readState(page)).score).toBe(0)
  await expect(bestText).toHaveText('46')
  await page.locator('[data-new-game]').click()
  await expect(bestText).toHaveText('46')
})

test('losing posts the final score once and shows saved', async ({ page }) => {
  const bodies = await mockScores(page, [{ delayMs: 600 }])
  await open(page)
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')

  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  expect((await readState(page)).status).toBe('lost')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'pending')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'saved')
  await expect(page.locator('[data-retry]')).toHaveCount(0)

  await pressArrow(page, 'ArrowRight')
  await pressArrow(page, 'ArrowUp')
  await page.waitForTimeout(300)
  expect(bodies).toEqual([{ score: 7, maxTile: 1024 }])

  await pressLetter(page, 'n')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')
})

test('failed submissions show retry and retry resends the same score', async ({ page }) => {
  const bodies = await mockScores(page, [{ networkError: true }, { status: 500 }, { status: 200 }])
  await open(page)
  await expect(page.locator('[data-retry]')).toHaveCount(0)

  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'error')
  await expect(page.locator('[data-retry]')).toHaveCount(1)

  await page.locator('[data-retry]').click()
  await expect.poll(() => bodies.length).toBe(2)
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'error')

  await page.locator('[data-retry]').click()
  await expect.poll(() => bodies.length).toBe(3)
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'saved')
  await expect(page.locator('[data-retry]')).toHaveCount(0)
  expect(bodies).toEqual([
    { score: 7, maxTile: 1024 },
    { score: 7, maxTile: 1024 },
    { score: 7, maxTile: 1024 },
  ])
})

test('new game and undo abort a pending submission', async ({ page }) => {
  const bodies = await mockScores(page, [{ delayMs: 800 }])
  await open(page)

  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'pending')
  await pressLetter(page, 'n')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')
  await page.waitForTimeout(1200)
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')
  expect((await readState(page)).status).toBe('playing')

  await setGrid(page, nearLostBoard, 7)
  await pressArrow(page, 'ArrowLeft')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'pending')
  await page.locator('[data-undo]').click()
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')
  expect(await readState(page)).toEqual({ board: nearLostBoard, score: 7, status: 'playing' })
  await page.waitForTimeout(1200)
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'idle')

  await pressArrow(page, 'ArrowLeft')
  await expect(submitAttr(page)).toHaveAttribute('data-submit', 'saved')
  expect(bodies).toHaveLength(3)
})
