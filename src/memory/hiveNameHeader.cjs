const { createHash } = require('node:crypto');

/** The shared, HTTP-header-safe first stage of every connection's hive name. */
exports.hiveNameHeader = function hiveNameHeader(label) {
  const raw = typeof label === 'string' ? label.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (raw === '') return 'unnamed';
  const text = raw.replace(/[^\t\x20-\x7e\xa0-\xff]/g, '').replace(/\s+/g, ' ').trim();
  if (text === '') return `agent-${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)}`;
  return text.slice(0, 80);
};
