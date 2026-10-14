import { h } from '@reatom/jsx'
import {
  SIZE,
  best,
  board,
  history,
  newGame,
  play,
  retrySubmit,
  score,
  status,
  submission,
  undo,
  type Dir,
} from './model'

const shellStyle = `
  box-sizing: border-box;
  width: max-content;
  margin: 24px auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: system-ui, sans-serif;
`

const boardStyle = `
  display: grid;
  grid-template-columns: repeat(4, 72px);
  grid-auto-rows: 72px;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  background: #bbada0;
`

const cellStyle = `
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: #cdc1b4;
  color: #776e65;
  font-size: 24px;
  font-weight: 700;
  &[data-v='2'] { background: #eee4da; }
  &[data-v='4'] { background: #ede0c8; }
  &[data-v='8'] { background: #f2b179; color: #f9f6f2; }
  &[data-v='16'] { background: #f59563; color: #f9f6f2; }
  &[data-v='32'] { background: #f67c5f; color: #f9f6f2; }
  &[data-v='64'] { background: #f65e3b; color: #f9f6f2; }
  &[data-v='128'] { background: #edcf72; color: #f9f6f2; font-size: 20px; }
  &[data-v='256'] { background: #edcc61; color: #f9f6f2; font-size: 20px; }
  &[data-v='512'] { background: #edc850; color: #f9f6f2; font-size: 20px; }
  &[data-v='1024'] { background: #edc53f; color: #f9f6f2; font-size: 18px; }
  &[data-v='2048'] { background: #edc22e; color: #f9f6f2; font-size: 18px; }
`

const cellText = (row: number, col: number) => {
  const value = board()[row]![col]!
  return value === 0 ? '' : String(value)
}

const Cell = ({ row, col }: { row: number; col: number }) => (
  <div data-cell={`${row}-${col}`} data-v={() => board()[row]![col]} css={cellStyle}>
    {() => cellText(row, col)}
  </div>
)

const Board = () => {
  const cells = []
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) cells.push(<Cell row={row} col={col} />)
  }
  return (
    <div data-board css={boardStyle}>
      {cells}
    </div>
  )
}

const directions: Array<{ dir: Dir; label: string }> = [
  { dir: 'up', label: 'Up' },
  { dir: 'left', label: 'Left' },
  { dir: 'down', label: 'Down' },
  { dir: 'right', label: 'Right' },
]

export const App = () => {
  const controls = directions.map(({ dir, label }) => (
    <button type="button" data-move={dir} on:click={() => play(dir)}>
      {label}
    </button>
  ))
  controls.push(
    <button type="button" data-undo disabled={() => history().length === 0} on:click={() => undo()}>
      Undo
    </button>,
    <button type="button" data-new-game on:click={() => newGame()}>
      New game
    </button>,
  )
  const retryButton = () =>
    submission() === 'error' ? (
      <button type="button" data-retry on:click={() => retrySubmit()}>
        Retry
      </button>
    ) : null
  return (
    <main css={shellStyle}>
      <h1 css="margin: 0; font-size: 40px;">2048</h1>
      <p css="margin: 0;">Arrow keys move tiles. u or Undo steps back. n or New game restarts.</p>
      <p css="margin: 0; display: flex; gap: 16px; align-items: baseline;">
        <span>
          Score <strong data-score={() => String(score())}>{() => String(score())}</strong>
        </span>
        <span>
          Best <strong data-best>{() => String(best())}</strong>
        </span>
        <span>
          <span data-status={() => status()}>{() => status()}</span>
        </span>
      </p>
      <p css="margin: 0; display: flex; gap: 8px; align-items: baseline;">
        Submission <span data-submit={() => submission()}>{() => submission()}</span>
        {retryButton}
      </p>
      <Board />
      <div css="display: flex; gap: 8px;">{controls}</div>
    </main>
  )
}
