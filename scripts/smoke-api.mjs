const base = (process.env.API_BASE_URL || 'http://127.0.0.1').replace(/\/$/, '');
const username = `smoke_${Date.now()}`;
const password = '123456';

const request = async (path, init = {}, expected = 200) => {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (response.status !== expected) {
    throw new Error(`${init.method || 'GET'} ${path}: expected ${expected}, got ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
};

const authHeaders = (session) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${session.accessToken}`,
});

const session = await request('/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
let headers = authHeaders(session);

const boxId = crypto.randomUUID();
const itemId = crypto.randomUUID();
const box = await request('/boxes', {
  method: 'POST',
  headers,
  body: JSON.stringify({ id: boxId, name: 'Smoke box', code: `SMOKE-${Date.now()}` }),
});
await request('/items', {
  method: 'POST',
  headers,
  body: JSON.stringify({ id: itemId, boxId, name: 'Smoke item', quantity: 3 }),
});
await request(`/items/${itemId}/movements`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ operationId: crypto.randomUUID(), type: 'out', quantity: 1 }),
});
const shared = await request(`/shared/boxes/${boxId}?token=${encodeURIComponent(box.shareToken)}`);
if (shared.items[0]?.quantity !== 2) throw new Error('Shared QR result did not reflect the latest stock');

const updatedSession = await request('/auth/profile', {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ currentPassword: password, username: `${username}_u` }),
});
headers = authHeaders(updatedSession);
const data = await request('/data', { headers });
await request('/restore', {
  method: 'POST',
  headers,
  body: JSON.stringify(data),
});
await request(`/boxes/${boxId}`, { method: 'DELETE', headers });

console.log(JSON.stringify({ ok: true, base, checks: ['short-credentials', 'stock', 'shared-qr', 'profile', 'restore', 'delete'] }));
