// A render process that records whether requests carry a document's state, and answers like one
// that keeps the three most recently used documents: a request without the state of a document it
// does not hold gets `missing-doc`. Results: { withState, attempts } (attempts: times received).
const MAX_DOCUMENTS = 3;
const docs = new Map();
const attempts = new Map();
process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (m.type === 'clear') return docs.clear();
  if (m.type === 'release') return;
  const n = (attempts.get(m.id) ?? 0) + 1;
  attempts.set(m.id, n);
  if (m.doc) {
    if (!m.doc.update && docs.get(m.doc.key) !== m.doc.version) {
      process.send({ type: 'error', id: m.id, message: 'missing document', kind: 'missing-doc' });
      return;
    }
    docs.delete(m.doc.key);
    docs.set(m.doc.key, m.doc.version);
    while (docs.size > MAX_DOCUMENTS) docs.delete(docs.keys().next().value);
  }
  process.send({ type: 'result', id: m.id, result: { withState: !!m.doc?.update, attempts: n } });
});
process.send({ type: 'ready', pid: process.pid, heapLimitMb: 1 });
