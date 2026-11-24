import { record } from '../driver-assistant/contracts.ts';
import type { AskRequest } from '../_shared/askSensi.ts';

export function wantsAnalyticalResponse(request: AskRequest): boolean {
  return !!(request.context || request.version === 3)
    && /\b(?:compare|comparison|analysis|analy[sz]e|breakdown|trends?|in (?:more )?detail|explain (?:my|these|the recorded)|why .{0,60}(?:higher|lower|changed|increase|decrease)|comparar|compara|analiza|tendencias|en detalle)\b/iu
      .test(request.question);
}

const list = { type: 'array', items: { type: 'string' } };
export const analyticalFormat = {
  type: 'json_schema', name: 'drivesense_ask_analysis', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      intro: { type: 'string' },
      heading: { type: ['string', 'null'] },
      observations: list,
      table: { anyOf: [{ type: 'null' }, {
        type: 'object', additionalProperties: false, required: ['headers', 'rows'],
        properties: { headers: list, rows: { type: 'array', items: list } },
      }] },
      limitations: list,
    },
    required: ['intro', 'heading', 'observations', 'table', 'limitations'],
  },
};

export function formatAnalyticalResponse(value: unknown): string | null {
  if (!record(value) || Object.keys(value).length !== 5 || typeof value.intro !== 'string'
    || !value.intro.trim() || !(value.heading === null || typeof value.heading === 'string')) return null;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 12
    && v.every(item => typeof item === 'string' && item.trim());
  if (!strings(value.observations) || !strings(value.limitations)) return null;
  const singleLine = (text: string) => text.trim().replace(/\r?\n/g, ' ');
  const formatted = [value.intro.trim()];
  if (value.heading?.trim()) formatted.push('### ' + singleLine(value.heading));
  if (value.observations.length) formatted.push(value.observations.map(item => '- ' + singleLine(item)).join('\n'));
  if (value.table !== null) {
    if (!record(value.table) || !strings(value.table.headers) || !Array.isArray(value.table.rows)
      || value.table.rows.length > 12 || !value.table.rows.every(strings)) return null;
    const { headers, rows } = value.table;
    if (headers.length >= 2 && headers.length <= 6 && rows.length > 0
      && rows.every(row => row.length === headers.length)
      && [headers, ...rows].every(row => row.every(cell => !/[|\r\n]/u.test(cell)))) {
      const row = (cells: string[]) => '| ' + cells.map(singleLine).join(' | ') + ' |';
      formatted.push([row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n'));
    } else if (rows.length > 0) {
      formatted.push(rows.map(cells => '- ' + cells.map((cell, i) =>
        (headers[i] ? singleLine(headers[i]) + ': ' : '') + singleLine(cell)).join(' · ')).join('\n'));
    }
  }
  if (value.limitations.length) formatted.push(value.limitations.map(singleLine).join('\n\n'));
  return formatted.join('\n\n');
}
