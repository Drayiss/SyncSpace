import WebSocket from 'ws';
export const base = process.env.API_BASE ?? 'http://127.0.0.1:5080';
export const second = process.env.API_BASE_2 ?? 'http://127.0.0.1:5081';
export async function create(title = 'Test document') {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(`Create failed: ${response.status}`);
  return response.json();
}
export async function read(doc, path = '', host = base) {
  const response = await fetch(`${host}/api/documents/${doc.id}${path}`, {
    headers: { Authorization: `Bearer ${doc.key}` },
  });
  if (!response.ok) throw new Error(`Read failed: ${response.status}`);
  return response.json();
}
export function connect(doc, host = base, key = doc.key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${host.replace(/^http/, 'ws')}/ws/documents/${doc.id}`);
    const messages = [];
    const waiters = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Join timed out'));
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', key })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      for (const waiter of [...waiters])
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      if (message.type === 'joined') {
        clearTimeout(timer);
        resolve({
          ws,
          messages,
          send: (value) => ws.send(JSON.stringify(value)),
          wait: (predicate, timeout = 10_000) => {
            const existing = messages.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
              const waiter = {
                predicate,
                resolve,
                timer: setTimeout(() => {
                  waiters.splice(waiters.indexOf(waiter), 1);
                  reject(new Error('Event timed out'));
                }, timeout),
              };
              waiters.push(waiter);
            });
          },
          close: () =>
            new Promise((resolve) => {
              if (ws.readyState === WebSocket.CLOSED) return resolve();
              ws.once('close', resolve);
              ws.close();
            }),
        });
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (!messages.some((m) => m.type === 'joined')) reject(new Error(`Join refused (${code})`));
    });
  });
}
export const insert = (id, after, text) =>
  [...text]
    .flatMap((c) => c.split(''))
    .map((c, index) => ({
      kind: 'insert',
      id: `${String(index + 1).padStart(12, '0')}:${id}`,
      after: index ? `${String(index).padStart(12, '0')}:${id}` : after,
      value: c.charCodeAt(0),
    }));
