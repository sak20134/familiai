// Clears a plain one-colour background from the bot picture, right in the window.
// Same idea as src/main/background.ts (the window cannot import main-process code).

export function removeBackgroundPixels(
  rgba: Uint8ClampedArray, width: number, height: number, tolerance: number,
): { removed: number; reason?: string } {
  const tol2 = tolerance * tolerance;
  const d2 = (i: number, r: number, g: number, b: number) => {
    const dr = (rgba[i] ?? 0) - r, dg = (rgba[i + 1] ?? 0) - g, db = (rgba[i + 2] ?? 0) - b;
    return dr * dr + dg * dg + db * db;
  };
  const px = (x: number, y: number) => (y * width + x) * 4;
  const c0 = px(0, 0);
  const bg = [rgba[c0] ?? 0, rgba[c0 + 1] ?? 0, rgba[c0 + 2] ?? 0] as const;
  const corners = [c0, px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
  if (corners.some((c) => d2(c, bg[0], bg[1], bg[2]) > tol2)) {
    return { removed: 0, reason: 'The background is not one plain color, so I left it alone.' };
  }
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0, removed = 0;
  const push = (x: number, y: number) => {
    const idx = y * width + x;
    if (seen[idx] || d2(idx * 4, bg[0], bg[1], bg[2]) > tol2) return;
    seen[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (head < tail) {
    const idx = queue[head++] as number;
    rgba[idx * 4 + 3] = 0;
    removed++;
    const x = idx % width, y = (idx - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return { removed };
}
