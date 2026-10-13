import type { StoredStructuredRow } from '../../src/context/rowStore';

/** The `value` of a fact row's payload; `undefined` for event and preference payloads, which have none. */
export function factValue(row: Pick<StoredStructuredRow, 'payload'>): string | undefined {
  return 'value' in row.payload ? row.payload.value : undefined;
}
