// Pure SAP Cloud ALM data helpers: API timestamps, lookback windows, OTLP log
// record flattening and analytics table reading/aggregation. No I/O.

/** Cloud ALM `YYYYMMDDHHmmss` UTC timestamp. */
export function calmTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

/** Window ending at `end` (ISO, default now) and spanning `spanMs`. */
export function lookbackWindow({ end, spanMs, now = Date.now }) {
  const endMs = end === undefined ? now() : Date.parse(end);
  const startMs = endMs - spanMs;
  return {
    startMs,
    endMs,
    from: calmTimestamp(startMs),
    to: calmTimestamp(endMs),
    from_iso: new Date(startMs).toISOString(),
    to_iso: new Date(endMs).toISOString()
  };
}

function cap(value, max) {
  return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
}

function nanosToIso(value) {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const date = new Date(Number(BigInt(value) / 1000000n));
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function anyValue(value, max) {
  if (!value || typeof value !== 'object') return value;
  if ('stringValue' in value) return cap(value.stringValue, max);
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) {
    const number = Number(value.intValue);
    return Number.isSafeInteger(number) ? number : String(value.intValue);
  }
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('arrayValue' in value) return (value.arrayValue?.values ?? []).map(entry => anyValue(entry, max));
  if ('kvlistValue' in value) return keyValues(value.kvlistValue?.values, max);
  if ('bytesValue' in value) return '[bytes]';
  return undefined;
}

function keyValues(entries, max) {
  const result = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.key === 'string') result[entry.key] = anyValue(entry.value, max);
  }
  return result;
}

/** Flatten an OTLP JSON logs payload into one plain record per log record. */
export function flattenLogRecords(payload, { bodyMax = 2048, valueMax = 512 } = {}) {
  const records = [];
  for (const resourceLog of payload?.resourceLogs ?? []) {
    const resource = keyValues(resourceLog?.resource?.attributes, valueMax);
    const service = {
      name: resource['service.name'],
      type: resource['service.namespace'],
      display_name: resource['sap.service.display_name'],
      instance_id: resource['service.instance.id']
    };
    for (const scopeLog of resourceLog?.scopeLogs ?? []) {
      for (const record of scopeLog?.logRecords ?? []) {
        records.push({
          time: nanosToIso(record.timeUnixNano),
          observed_time: nanosToIso(record.observedTimeUnixNano),
          severity: record.severityText || record.severityNumber,
          body: anyValue(record.body, bodyMax),
          service,
          attributes: keyValues(record.attributes, valueMax)
        });
      }
    }
  }
  return records;
}

/** Read one analytics table entry into row objects keyed by column text. */
export function readAnalyticsTable(entry) {
  const columns = entry?.columns ?? entry?.COLUMNS ?? [];
  const data = entry?.rows ?? entry?.ROWS ?? [];
  const rows = data.map(values => Object.fromEntries(columns.map((column, index) => {
    const value = values?.[index];
    return [column.text, column.type === 'time' && value !== null && value !== undefined
      ? new Date(Number(value)).toISOString()
      : value];
  })));
  const total = Number.isFinite(Number(entry?.totalCount)) && entry?.totalCount !== null && entry?.totalCount !== undefined
    ? Number(entry.totalCount)
    : null;
  const count = entry?.count;
  const truncated = total !== null && count !== null && count !== undefined && Number.isFinite(Number(count)) && total > Number(count);
  return { columns, rows, total, truncated };
}

/** Group rows by dimension columns (time dropped) and combine measures by sum or max; sorted by the first measure. */
export function aggregateAnalyticsRows(table, mode) {
  const columns = table.columns.filter(column => column.type !== 'time');
  const measures = columns.filter(column => column.type === 'number').map(column => column.text);
  const dimensions = columns.filter(column => column.type !== 'number').map(column => column.text);
  const groups = new Map();
  for (const row of table.rows) {
    const id = JSON.stringify(dimensions.map(name => row[name]));
    let group = groups.get(id);
    if (!group) {
      group = Object.fromEntries(dimensions.map(name => [name, row[name]]));
      for (const name of measures) group[name] = null;
      groups.set(id, group);
    }
    for (const name of measures) {
      const value = Number(row[name]);
      if (row[name] === null || row[name] === undefined || !Number.isFinite(value)) continue;
      group[name] = group[name] === null ? value : mode === 'max' ? Math.max(group[name], value) : group[name] + value;
    }
  }
  const first = measures[0];
  const result = [...groups.values()];
  if (first !== undefined) result.sort((a, b) => (b[first] ?? -Infinity) - (a[first] ?? -Infinity));
  return result;
}
