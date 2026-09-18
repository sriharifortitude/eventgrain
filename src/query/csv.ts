import type { QueryResult } from './run.js';

/** RFC 4180: quote when needed, double embedded quotes, CRLF line ends. */
export function csvLine(fields: ReadonlyArray<string | number | null | undefined>): string {
  return (
    fields
      .map((field) => {
        if (field === null || field === undefined) return '';
        const text = String(field);
        // A leading =, +, - or @ would be executed as a formula by spreadsheet
        // software opening the file; a leading apostrophe makes it text.
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
      })
      .join(',') + '\r\n'
  );
}

export function resultToCsv(result: QueryResult): string {
  switch (result.metric) {
    case 'count':
    case 'unique': {
      const grouped = result.series.some((point) => 'group' in point);
      const header = csvLine(grouped ? ['bucket', 'group', result.metric] : ['bucket', result.metric]);
      return header + result.series.map((point) => csvLine(grouped ? [point.bucket, point.group ?? '', point.value] : [point.bucket, point.value])).join('');
    }
    case 'funnel':
      return csvLine(['step', 'event', 'count', 'conversion']) + result.steps.map((step, i) => csvLine([i + 1, step.event, step.count, step.conversion.toFixed(4)])).join('');
    case 'retention': {
      const periods = result.cohorts[0]?.periods.length ?? 0;
      const header = csvLine(['cohort', 'size', ...Array.from({ length: periods }, (_, i) => `week_${i}`)]);
      return header + result.cohorts.map((row) => csvLine([row.cohort, row.size, ...row.periods])).join('');
    }
  }
}
