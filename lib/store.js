import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DATA_FILE = join(process.cwd(), 'data', 'app.json');

const initialData = {
  messages: [],
  sends: [],
  bulkJobs: [],
};

let writeQueue = Promise.resolve();

export async function readStore() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      sends: Array.isArray(parsed.sends) ? parsed.sends : [],
      bulkJobs: Array.isArray(parsed.bulkJobs) ? parsed.bulkJobs : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      await saveStore(initialData);
      return structuredClone(initialData);
    }

    throw error;
  }
}

export async function updateStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const data = await readStore();
    const next = await mutator(data);
    await saveStore(next ?? data);
    return next ?? data;
  });

  return writeQueue;
}

export async function saveStore(data) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  const json = `${JSON.stringify(data, null, 2)}\n`;

  await writeFile(tempFile, json, { mode: 0o600 });
  await rename(tempFile, DATA_FILE);
}

export function upsertById(items, item) {
  const index = items.findIndex((entry) => entry.id === item.id);

  if (index === -1) {
    items.unshift(item);
    return;
  }

  items[index] = { ...items[index], ...item };
}
