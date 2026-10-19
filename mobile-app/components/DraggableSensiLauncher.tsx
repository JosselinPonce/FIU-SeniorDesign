import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { greetingPosition } from '../lib/ui/launcherGreeting';
import * as repo from '../lib/db/repositories';
import { clampPosition, DRAG_SLOP, readSavedPosition, defaultVitalsPosition, restorePosition } from '../lib/ui/floatingSensi';

/** Home bounds exclude the safe-area header and tabs. Only the circular launcher receives touches. */
export function DraggableSensiLauncher({ children, defaultAnchor }: { children: ReactNode; defaultAnchor?: { y: number; height: number } | null }) {
  const { tokens } = useTheme();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [pillSize, setPillSize] = useState({ width: 130, height: 32 });
  const translation = useRef(new Animated.ValueXY()).current;
  const geometry = useRef({ width: 0, height: 0, itemWidth: 58, itemHeight: 58 });
  const position = useRef({ x: 0, y: 0 });
  const fraction = useRef<{ x: number; y: number } | null>(null);
  const anchor = useRef(defaultAnchor ?? null); anchor.current = defaultAnchor ?? null;
  const [loaded, setLoaded] = useState(false);
  const dragging = useRef(false);
  const moved = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const [measured, setMeasured] = useState(false);
  function restore() {
    const g = geometry.current;
    position.current = fraction.current ? restorePosition(fraction.current, g.width, g.height, g.itemWidth, g.itemHeight)
      : defaultVitalsPosition(g.width, g.height, anchor.current);
    translation.setValue(position.current);
  }
  useEffect(() => {
    let current = true;
    void Promise.all([repo.getSetting('sensi:launcher-position'), repo.getSetting('sensi:launcher-y')]).then(([value, legacy]) => {
      if (current && !moved.current) { fraction.current = readSavedPosition(value, legacy); restore(); setViewport({ width: geometry.current.width, height: geometry.current.height }); }
    }).catch(() => {}).finally(() => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, []);
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => Math.hypot(gesture.dx, gesture.dy) > DRAG_SLOP,
    onPanResponderGrant: () => { dragging.current = true; moved.current = true; origin.current = position.current; },
    onPanResponderMove: (_event, gesture) => {
      const g = geometry.current;
      position.current = clampPosition(origin.current.x + gesture.dx, origin.current.y + gesture.dy, g.width, g.height, g.itemWidth, g.itemHeight);
      translation.setValue(position.current);
      setViewport({ width: g.width, height: g.height });
    },
    onPanResponderRelease: () => {
      const g = geometry.current;
      fraction.current = { x: position.current.x / Math.max(1, g.width - g.itemWidth), y: position.current.y / Math.max(1, g.height - g.itemHeight) };
      dragging.current = false; restore();
      void repo.setSetting('sensi:launcher-position', JSON.stringify(fraction.current)).catch(() => {});
    },
    onPanResponderTerminate: () => { dragging.current = false; restore(); setViewport({ width: geometry.current.width, height: geometry.current.height }); },
    onPanResponderTerminationRequest: () => true,
  })).current;
  useEffect(() => {
    if (!fraction.current && !dragging.current) { restore(); setViewport({ width: geometry.current.width, height: geometry.current.height }); }
  }, [defaultAnchor?.y, defaultAnchor?.height]);
  const pill = greetingPosition(position.current, viewport.width, viewport.height, pillSize.width, pillSize.height);
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
    onLayout={({ nativeEvent: { layout } }) => { geometry.current = { ...geometry.current, width: layout.width, height: layout.height }; restore(); setViewport({ width: layout.width, height: layout.height }); setMeasured(true); }}>
    <Animated.View pointerEvents="box-none" {...responder.panHandlers} style={{ position: 'absolute', top: 0, left: 0, width: 58, opacity: measured && loaded ? 1 : 0, transform: translation.getTranslateTransform() }}
      onLayout={({ nativeEvent: { layout } }) => { geometry.current = { ...geometry.current, itemWidth: layout.width, itemHeight: layout.height }; if (!dragging.current) restore(); }}>
      {children}
    </Animated.View>
    {measured && loaded ? <View pointerEvents="none" accessible={false}
      style={{ position: 'absolute', left: pill.x, top: pill.y, maxWidth: viewport.width, borderRadius: 18,
        paddingHorizontal: 10, paddingVertical: 6, backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border }}
      onLayout={({ nativeEvent: { layout } }) => { setPillSize(previous => previous.width === layout.width && previous.height === layout.height ? previous : { width: layout.width, height: layout.height }); }}>
      <Text numberOfLines={1} style={{ color: tokens.text, fontSize: 13 }}>Hi, I'm Sensi!</Text>
    </View> : null}
  </View>;
}
