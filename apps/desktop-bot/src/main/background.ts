// Basic background remover: flood-fills from the picture's edges, clearing pixels close to the corner color.
// Works well on plain backgrounds (white, studio grey, flat color). It cannot cut out busy backgrounds.

export interface RemoveResult {
  removed: number;
  skippedReason?: string;
}

/** `rgba` is changed in place. Returns how many pixels were made transparent. */
export function removeBackground(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tolerance = 40,
): RemoveResult {
  if (width < 2 || height < 2 || rgba.length !== width * height * 4) {
    return { removed: 0, skippedReason: 'Unexpected image size.' };
  }
  const px = (x: number, y: number) => (y * width + x) * 4;
  const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
  const tol2 = tolerance * tolerance;
  const dist2 = (i: number, r: number, g: number, b: number) => {
    const dr = (rgba[i] ?? 0) - r;
    const dg = (rgba[i + 1] ?? 0) - g;
    const db = (rgba[i + 2] ?? 0) - b;
    return dr * dr + dg * dg + db * db;
  };

  const c0 = corners[0]!;
  const bg = [rgba[c0] ?? 0, rgba[c0 + 1] ?? 0, rgba[c0 + 2] ?? 0] as const;
  // If the corners disagree, the background is busy: do nothing rather than ruin the picture.
  if (corners.some((c) => dist2(c, bg[0], bg[1], bg[2]) > tol2)) {
    return { removed: 0, skippedReason: 'The background is not one plain color.' };
  }

  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (x: number, y: number) => {
    const idx = y * width + x;
    if (seen[idx]) return;
    if (dist2(idx * 4, bg[0], bg[1], bg[2]) > tol2) return;
    seen[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  let removed = 0;
  while (head < tail) {
    const idx = queue[head++]!;
    rgba[idx * 4 + 3] = 0;
    removed++;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return { removed };
}
