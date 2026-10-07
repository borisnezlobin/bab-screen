import { hashWords } from "./chain-blocks";

/** A block hash is drawn as 8 rows of 32 parallelogram cells, one cell per bit, in rows of alternating slant. */
export const GLYPH_ROWS = 8;
export const GLYPH_COLUMNS = 32;
export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 7;
const CELL_GAP = 1.5;
const SLANT = CELL_HEIGHT * Math.tan(Math.PI / 6);
export const GLYPH_WIDTH = GLYPH_COLUMNS * CELL_WIDTH + SLANT;
export const GLYPH_HEIGHT = GLYPH_ROWS * CELL_HEIGHT;

function cellPath(row: number, column: number) {
  const x = column * CELL_WIDTH;
  const y = row * CELL_HEIGHT;
  const right = CELL_WIDTH - CELL_GAP;
  const bottom = y + CELL_HEIGHT - CELL_GAP;
  const [topShift, bottomShift] = row % 2 === 0 ? [SLANT, 0] : [0, SLANT];
  const f = (n: number) => n.toFixed(2);
  return `M${f(x + topShift)} ${f(y)}h${f(right)}L${f(x + bottomShift + right)} ${f(bottom)}h${f(-right)}Z`;
}

const ALL_CELLS = Array.from({ length: GLYPH_ROWS * GLYPH_COLUMNS }, (_, bit) => cellPath(Math.floor(bit / GLYPH_COLUMNS), bit % GLYPH_COLUMNS));

/** Every cell of the glyph as one path: the outline of a block whose hash is not known yet. */
export const EMPTY_GLYPH = ALL_CELLS.join("");

/** The hash's 1 bits and 0 bits as two paths, most significant bit at the top left. */
export function glyphPaths(hash: string): { ones: string; zeros: string } {
  const words = hashWords(hash);
  let ones = "";
  let zeros = "";
  ALL_CELLS.forEach((cell, bit) => {
    const set = (words[Math.floor(bit / 32)] >>> (31 - (bit % 32))) & 1;
    if (set) ones += cell;
    else zeros += cell;
  });
  return { ones, zeros };
}
