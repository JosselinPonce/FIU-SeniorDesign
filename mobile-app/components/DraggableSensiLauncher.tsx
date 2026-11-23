import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { defaultLauncherPosition, greetingPosition } from '../lib/ui/launcherGreeting';
import * as repo from '../lib/db/repositories';
import { clampPosition, dockLauncher, DRAG_SLOP, readLauncherPreference, restorePosition, type LauncherPreference } from '../lib/ui/floatingSensi';

const SIZE = 58;
const launcherWidth = (width: number) => width >= SIZE + 44 ? SIZE + 44 : SIZE;
let pendingWrite = Promise.resolve();
let greetingDismissed = false;

/** The measured dashboard bounds are inside the shell's safe area, header and tab bar. */
export function DraggableSensiLauncher({ children, defaultAnchor, driverId, scrollStart = 0 }: {
  driverId: string;
  scrollStart?: number;
  children(collapse: () => void, showGreeting: () => void): ReactNode;
  defaultAnchor?: { y: number; height: number } | null;
}) {
  const { tokens } = useTheme();
  const translation = useRef(new Animated.ValueXY()).current;
  const greetingTranslation = useRef(new Animated.ValueXY()).current;
  const heading = useRef(defaultAnchor ?? null);
  heading.current = defaultAnchor ?? null;
  const geometry = useRef({ width: 0, height: 0 });
  const position = useRef({ x: 0, y: 0 });
  const fraction = useRef<LauncherPreference | null>(null);
  const preferenceKey = `sensi:launcher-position:${driverId}`;
  const dragging = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const measured = viewport.width >= SIZE && viewport.height >= SIZE;
  const [preference, setPreference] = useState<LauncherPreference | null>(null);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const lastScrollStart = useRef(scrollStart);
  const collapsed = Boolean(preference?.collapsed) || autoCollapsed;
  const canDrag = useRef(!collapsed);
  canDrag.current = !collapsed;
  const dockedLeft = preference?.x === 0;
  const [greetingVisible, setGreetingVisible] = useState(!greetingDismissed);
  const [greetingSize, setGreetingSize] = useState({ width: 76, height: 44 });

  function restore(animate = false) {
    const { width, height } = geometry.current;
    position.current = fraction.current ? restorePosition(fraction.current, width, height, launcherWidth(width), SIZE)
      : defaultLauncherPosition(width, height, launcherWidth(width), SIZE, heading.current);
    translation.stopAnimation();
    if (animate) Animated.spring(translation, { toValue: position.current, useNativeDriver: false, overshootClamping: true }).start();
    else translation.setValue(position.current);
  }
  function save(p: LauncherPreference, animate = false) {
    fraction.current = p;
    setPreference(p);
    restore(animate);
    pendingWrite = pendingWrite.then(() => repo.setSetting(preferenceKey, JSON.stringify(p))).catch(() => {});
  }
  function collapse() {
    const { width, height } = geometry.current;
    save(dockLauncher(position.current.x, position.current.y, width, height, SIZE, true, launcherWidth(width)));
  }
  useEffect(() => {
    let current = true;
    void pendingWrite.then(() => repo.getSetting(preferenceKey)).then(value => {
      if (!current) return;
      fraction.current = readLauncherPreference(value);
      setPreference(fraction.current);
      restore();
    }).catch(() => {}).finally(() => { if (current) setReady(true); });
    return () => { current = false; translation.stopAnimation(); };
  }, [preferenceKey]);
  function showGreeting() { greetingDismissed = false; setGreetingVisible(true); }
  function expand() {
    setAutoCollapsed(false);
    if (preference?.collapsed) save({ ...preference, collapsed: false });
    showGreeting();
  }
  useEffect(() => {
    if (lastScrollStart.current === scrollStart) return;
    lastScrollStart.current = scrollStart;
    if (dragging.current) {
      dragging.current = false;
      restore();
    }
    setAutoCollapsed(true);
  }, [scrollStart]);
  function dismissGreeting() { greetingDismissed = true; setGreetingVisible(false); }
  useEffect(() => {
    const update = (point: { x: number; y: number }) => {
      const { width, height } = geometry.current;
      const icon = { x: point.x + (fraction.current?.x === 0 ? 0 : launcherWidth(width) - SIZE), y: point.y };
      greetingTranslation.setValue(greetingPosition(icon, width, height, greetingSize.width, greetingSize.height, SIZE));
    };
    const subscription = translation.addListener(update);
    if (!fraction.current && !dragging.current) restore();
    else update(position.current);
    return () => translation.removeListener(subscription);
  }, [translation, greetingTranslation, viewport.width, viewport.height, greetingSize.width, greetingSize.height]);

  useEffect(() => {
    if (!dragging.current && !fraction.current && !collapsed) restore();
  }, [defaultAnchor?.y, defaultAnchor?.height, collapsed]);

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => canDrag.current && Math.hypot(gesture.dx, gesture.dy) > DRAG_SLOP,
    onPanResponderGrant: () => {
      dragging.current = true;
      origin.current = position.current;
      translation.stopAnimation(value => {
        if (dragging.current) { origin.current = value; position.current = value; }
      });
    },
    onPanResponderMove: (_event, gesture) => {
      if (!dragging.current) return;
      const { width, height } = geometry.current;
      position.current = clampPosition(origin.current.x + gesture.dx, origin.current.y + gesture.dy, width, height, launcherWidth(width), SIZE);
      translation.setValue(position.current);
    },
    onPanResponderRelease: () => {
      if (!dragging.current) return;
      dragging.current = false;
      const { width, height } = geometry.current;
      save(dockLauncher(position.current.x, position.current.y, width, height, SIZE, false, launcherWidth(width)), true);
    },
    onPanResponderTerminate: () => { dragging.current = false; restore(); },
    onPanResponderTerminationRequest: () => true,
  }), [translation]);
  const { width } = viewport;
  const greetingMaxWidth = Math.max(0, Math.min(152, width - 2 * SIZE));
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
    onLayout={({ nativeEvent: { layout } }) => {
      if (geometry.current.width !== layout.width || geometry.current.height !== layout.height) {
        dragging.current = false;
        geometry.current = { width: layout.width, height: layout.height };
        restore();
        setViewport(geometry.current);
      }
    }}>
    {measured && ready ? <Animated.View pointerEvents="box-none" {...responder.panHandlers}
      style={{ position: 'absolute', top: 0, left: 0, width: launcherWidth(width), height: SIZE, transform: translation.getTranslateTransform() }}>
      {collapsed ? <Pressable accessibilityRole="button" accessibilityLabel="Expand Sensi"
        onPress={expand} style={{ width: 44, height: 58,
          alignSelf: dockedLeft ? 'flex-start' : 'flex-end', alignItems: dockedLeft ? 'flex-start' : 'flex-end', justifyContent: 'center' }}>
        <View style={{ width: 22, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: tokens.primary }}>
          <Text accessible={false} style={{ color: tokens.onPrimary, fontSize: 18 }}>{dockedLeft ? '›' : '‹'}</Text>
        </View>
      </Pressable> : <>
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, ...(preference?.x === 0 ? { left: 0 } : { right: 0 }) }}>
          {children(collapse, showGreeting)}
        </View>
        {viewport.width >= SIZE + 44 ? <Pressable accessibilityRole="button" accessibilityLabel="Collapse Sensi" onPress={collapse}
          style={{ position: 'absolute', top: 7, ...(preference?.x === 0 ? { right: 0 } : { left: 0 }),
            width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text accessible={false} style={{ color: tokens.onPrimary, backgroundColor: tokens.primary, borderRadius: 10, paddingHorizontal: 6 }}>
            {preference?.x === 0 ? '‹' : '›'}
          </Text>
        </Pressable> : null}
      </>}
    </Animated.View> : null}
    {measured && ready && greetingVisible && !collapsed ? <Animated.View pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, maxWidth: greetingMaxWidth, minHeight: 44, transform: greetingTranslation.getTranslateTransform() }}
      onLayout={({ nativeEvent: { layout } }) => setGreetingSize(previous => previous.width === layout.width && previous.height === layout.height
        ? previous : { width: layout.width, height: layout.height })}>
      <View pointerEvents="none" style={{ marginTop: 4, paddingLeft: 6, paddingRight: 22, paddingVertical: 3,
        borderRadius: 13, backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border }}>
        <Text style={{ color: tokens.text, fontSize: 13, fontWeight: '600' }}>{"Hi! I'm\nSensi!"}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss Sensi greeting" onPress={dismissGreeting}
        style={{ position: 'absolute', top: 0, right: 10, width: 44, height: 44, alignItems: 'flex-end', paddingTop: 4 }}>
        <Text accessible={false} style={{ color: tokens.textSecondary, fontSize: 15 }}>×</Text>
      </Pressable>
    </Animated.View> : null}
  </View>;
}
