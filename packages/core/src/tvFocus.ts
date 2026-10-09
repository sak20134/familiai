// Step 31: remote (D-pad) focus movement for the TV app's rows of cards.

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Pos {
  row: number;
  col: number;
}

/** `rowSizes[i]` is how many cards row i has. Rows can have different lengths. */
export function moveFocus(rowSizes: readonly number[], pos: Pos, dir: Direction): Pos {
  const rows = rowSizes.length;
  if (rows === 0) return pos;
  const size = (r: number) => rowSizes[r] ?? 0;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

  switch (dir) {
    case 'left':
      return { row: pos.row, col: clamp(pos.col - 1, size(pos.row) - 1) };
    case 'right':
      return { row: pos.row, col: clamp(pos.col + 1, size(pos.row) - 1) };
    case 'up':
    case 'down': {
      const nextRow = clamp(pos.row + (dir === 'down' ? 1 : -1), rows - 1);
      if (size(nextRow) === 0) return pos; // skip empty rows by staying put
      return { row: nextRow, col: clamp(pos.col, size(nextRow) - 1) };
    }
  }
}
