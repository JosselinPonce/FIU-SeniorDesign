export function greetingPosition(icon: { x: number; y: number }, width: number, height: number, pillWidth: number, pillHeight: number) {
  const gap = 8;
  const right = icon.x + 58 + gap;
  const left = icon.x - gap - pillWidth;
  const beside = right + pillWidth <= width || left >= 0;
  const x = right + pillWidth <= width ? right : left >= 0 ? left : icon.x + (58 - pillWidth) / 2;
  const y = beside ? icon.y + (58 - pillHeight) / 2
    : icon.y >= pillHeight + gap ? icon.y - pillHeight - gap : icon.y + 58 + gap;
  return { x: Math.max(0, Math.min(x, Math.max(0, width - pillWidth))),
    y: Math.max(0, Math.min(y, Math.max(0, height - pillHeight))) };
}
