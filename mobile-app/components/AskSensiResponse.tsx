import { ScrollView, View } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { askInlineParts, parseAskMarkdown } from '../lib/assistant/askSensiMarkdown';

function Inline({ value }: { value: string }) {
  return <>{askInlineParts(value).map((part, index) => part.bold
    ? <Text key={index} localize={false} style={{ fontWeight: '700' }}>{part.text}</Text> : part.text)}</>;
}

export function AskSensiResponse({ message }: { message: string }) {
  const { tokens } = useTheme();
  const body = { color: tokens.text, fontSize: 16, lineHeight: 23 };
  const blocks = parseAskMarkdown(message);
  if (!blocks.length) return null;
  return <View style={{ gap: 12 }}>{blocks.map((block, index) => {
    if (block.kind === 'table') return <ScrollView key={index} horizontal nestedScrollEnabled showsHorizontalScrollIndicator keyboardShouldPersistTaps="handled">
      <View style={{ borderWidth: 1, borderColor: tokens.border, borderRadius: 8, overflow: 'hidden' }}>
        {block.rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: 'row',
          backgroundColor: rowIndex === 0 ? tokens.surfaceMuted : tokens.background,
          borderTopWidth: rowIndex ? 1 : 0, borderColor: tokens.border }}>
          {row.map((cell, column) => <Text key={column} localize={false} accessibilityRole={rowIndex === 0 ? 'header' : undefined}
            style={{ ...body, fontSize: 14, lineHeight: 20, width: 140, padding: 8, fontWeight: rowIndex === 0 ? '700' : '400' }}>
            <Inline value={cell} />
          </Text>)}
        </View>)}
      </View>
    </ScrollView>;
    if (block.kind === 'item') return <View key={index} style={{ flexDirection: 'row', gap: 7, paddingLeft: 8 + block.depth * 12 }}>
      <Text localize={false} style={body}>{block.marker}</Text>
      <Text localize={false} style={{ ...body, flex: 1 }}><Inline value={block.text} /></Text>
    </View>;
    return <Text key={index} localize={false} accessibilityRole={block.kind === 'heading' ? 'header' : undefined}
      style={block.kind === 'heading' ? { ...body, fontSize: 18, lineHeight: 25, fontWeight: '700', marginTop: index > 0 ? 4 : 0 } : body}><Inline value={block.text} /></Text>;
  })}</View>;
}
