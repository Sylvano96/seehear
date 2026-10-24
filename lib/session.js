// chrome.storage.session lives in RAM (10 MB max for the whole extension) and
// is cleared when the browser closes. Each kind of entry keeps only its last
// few items, tracked in a small index so pruning never reads the big entries.

export async function storeEntry(kind, entry, keep) {
  const id = crypto.randomUUID();
  const indexKey = `${kind}:index`;
  const index = (await chrome.storage.session.get(indexKey))[indexKey] || [];
  const old = index.splice(0, Math.max(0, index.length - (keep - 1)));
  if (old.length) await chrome.storage.session.remove(old.map((oldId) => `${kind}:${oldId}`));
  index.push(id);
  await chrome.storage.session.set({ [`${kind}:${id}`]: { ...entry, createdAt: Date.now() }, [indexKey]: index });
  return id;
}

export async function loadEntry(kind, id) {
  if (!id || id === "index") return null;
  const key = `${kind}:${id}`;
  return (await chrome.storage.session.get(key))[key] || null;
}

export function updateEntry(kind, id, entry) {
  return chrome.storage.session.set({ [`${kind}:${id}`]: entry });
}
