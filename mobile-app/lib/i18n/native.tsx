import { forwardRef, type ReactNode } from 'react';
import { Alert as NativeAlert, Text as NativeText, TextInput as NativeTextInput, Pressable as NativePressable,
  type TextProps, type TextInputProps, type PressableProps } from 'react-native';
import { translateCurrent, useAppLanguage } from './LanguageProvider';
export type LocalizedText = NativeText;
export type LocalizedTextInput = NativeTextInput;
export const LocalizedText = forwardRef<NativeText, TextProps & { localize?: boolean }>(({ children, localize = true, ...props }, ref) => {
  const { t } = useAppLanguage();
  const pieces = Array.isArray(children) ? children : [children];
  const scalar = pieces.every(piece => typeof piece === 'string' || typeof piece === 'number' || piece == null || typeof piece === 'boolean');
  let rendered: ReactNode = children;
  if (localize) {
    const joined = scalar ? pieces.filter(piece => piece != null && typeof piece !== 'boolean').join('') : '';
    rendered = joined && t(joined) !== joined ? t(joined) : pieces.map(piece => typeof piece === 'string' ? t(piece) : piece);
  }
  return <NativeText {...props} ref={ref} accessibilityLabel={props.accessibilityLabel ? t(props.accessibilityLabel) : undefined}>{rendered}</NativeText>;
});
export const LocalizedTextInput = forwardRef<NativeTextInput, TextInputProps>((props, ref) => {
  const { t } = useAppLanguage();
  return <NativeTextInput {...props} ref={ref} placeholder={props.placeholder ? t(props.placeholder) : undefined}
    accessibilityLabel={props.accessibilityLabel ? t(props.accessibilityLabel) : undefined} />;
});
export const LocalizedPressable = forwardRef<React.ElementRef<typeof NativePressable>, PressableProps>((props, ref) => {
  const { t } = useAppLanguage();
  return <NativePressable {...props} ref={ref} accessibilityLabel={props.accessibilityLabel ? t(props.accessibilityLabel) : undefined}
    accessibilityHint={props.accessibilityHint ? t(props.accessibilityHint) : undefined} />;
});
export const LocalizedAlert: typeof NativeAlert = {
  ...NativeAlert,
  alert(title, message, buttons, options) {
    NativeAlert.alert(translateCurrent(title), message ? translateCurrent(message) : message,
      buttons?.map(button => ({ ...button, text: button.text ? translateCurrent(button.text) : button.text })), options);
  },
};
