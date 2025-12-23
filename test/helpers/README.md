# Test Helpers

## Image Comparison (TODO)

Compare extracted covers with originals using ImageMagick RMSE metric.

### Approach

1. Resize both images to 200×200 (ignores aspect ratio with `!`)
2. Compare using `magick compare -metric RMSE`
3. Parse normalized value from output: `"3846.83 (0.0586988)"` → `0.059`
4. Threshold: RMSE < 0.1 (10%) = images are similar

### Verified Results

| Comparison | RMSE |
|------------|------|
| Identical | 0 |
| Resized + Q50 | ~0.06 |

### Command

```bash
magick compare -metric RMSE a.jpg b.jpg null: 2>&1
# Output: "3846.83 (0.0586988)" - value in () is normalized 0-1
```

### Implementation Sketch

```typescript
export async function compareImages(
  imageA: Buffer,
  imageB: Buffer,
  threshold = 0.1
): Promise<{ similar: boolean; rmse: number }> {
  const tmpA = `/tmp/compare_a_${Date.now()}.jpg`;
  const tmpB = `/tmp/compare_b_${Date.now()}.jpg`;

  await Bun.write(tmpA, imageA);
  await Bun.write(tmpB, imageB);

  // Resize both to 200x200
  await Bun.$`magick ${tmpA} -resize 200x200! ${tmpA}`.quiet();
  await Bun.$`magick ${tmpB} -resize 200x200! ${tmpB}`.quiet();

  // Compare
  const proc = Bun.spawn(
    ["magick", "compare", "-metric", "RMSE", tmpA, tmpB, "null:"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  // Parse normalized value
  const match = stderr.match(/\(([\d.]+)\)/);
  const rmse = match ? parseFloat(match[1]) : 1;

  await Bun.$`rm -f ${tmpA} ${tmpB}`.quiet();

  return { similar: rmse < threshold, rmse };
}
```

### Notes

- Requires ImageMagick (available in Docker)
- Output goes to stderr, not stdout
- `null:` discards difference image
