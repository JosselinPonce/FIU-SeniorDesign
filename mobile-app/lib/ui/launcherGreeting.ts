import { clampPosition } from './floatingSensi.ts';

/** The viewport already excludes the dashboard header, safe-area insets and tabs. */
export function defaultLauncherPosition(width: number, height: number, launcherWidth: number, launcherHeight: number,
  heading: { y: number; height: number } | null) {
  const y = heading ? heading.y + (heading.height - launcherHeight) / 2 : height / 4;
  return clampPosition(width - launcherWidth, y, width, height, launcherWidth, launcherHeight);
}

/** Keep the bubble attached at the icon's upper corner, including after docking. */
export function greetingPosition(icon: { x: number; y: number }, width: number, height: number,
  bubbleWidth: number, bubbleHeight: number, iconSize = 58) {
  const placeLeft = icon.x + iconSize / 2 >= width / 2;
  const overlap = Math.round(iconSize * 0.18);
  const inset = 6;
  const x = placeLeft ? icon.x - bubbleWidth + overlap : icon.x + iconSize - overlap;
  const y = icon.y - bubbleHeight + overlap;
  const position = clampPosition(x - inset, y - inset, width - 2 * inset, height - 2 * inset, bubbleWidth, bubbleHeight);
  return { x: position.x + inset, y: position.y + inset };
}
