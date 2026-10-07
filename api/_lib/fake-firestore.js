// Minimal in-memory fake of the firebase-admin Firestore surface used by
// api/_lib/order-core.js. No network, no Firebase credentials — this lets
// `node scripts/test-order-core.mjs` exercise the real transactional logic.
//
// It deliberately FAILS on dotted field paths (e.g. "inventory.0.quantity")
// the way a strict reviewer would want: production code must always write
// whole arrays/objects instead.

class Query {
  constructor(store, collection, conditions, orderField, orderDir, limitCount, afterValues) {
    this.store = store;
    this.collection = collection;
    this.conditions = conditions;
    this.orderField = orderField;
    this.orderDir = orderDir;
    this.limitCount = limitCount;
    this.afterValues = afterValues || null;
  }

  where(field, op, value) {
    if (field.includes('.')) throw new Error(`FakeFirestore forbids dotted query paths: ${field}`);
    if (op !== '==' && op !== 'in') throw new Error(`FakeFirestore only supports == / in queries, got ${op}`);
    return new Query(this.store, this.collection, [...this.conditions, [field, value, op]], this.orderField, this.orderDir, this.limitCount);
  }

  orderBy(field, dir = 'asc') {
    return new Query(this.store, this.collection, this.conditions, field, dir, this.limitCount);
  }

  limit(n) {
    return new Query(this.store, this.collection, this.conditions, this.orderField, this.orderDir, n, this.afterValues);
  }

  startAfter(...values) {
    return new Query(this.store, this.collection, this.conditions, this.orderField, this.orderDir, this.limitCount, values);
  }

  _rows(merged) {
    const docs = (merged || this.store.collections).get(this.collection) || new Map();
    let entries = [...docs.entries()].filter(([, data]) =>
      this.conditions.every(([field, value, op]) => (op === 'in' ? Array.isArray(value) && value.includes(data[field]) : data[field] === value))
    );
    // Behave like Firestore for composite queries: where() on one field plus
    // orderBy() on a DIFFERENT field needs an explicit composite index. The
    // test setup registers them with db.__addIndex(...) — without one the
    // query throws FAILED_PRECONDITION exactly like production does.
    if (this.orderField && this.conditions.length > 0) {
      const whereFields = [...new Set(this.conditions.map(([field]) => field))];
      const needsIndex = whereFields.some(f => f !== this.orderField);
      if (needsIndex) {
        const key = `${this.collection}|${[...whereFields, this.orderField].sort().join(',')}|${this.orderDir}`;
        if (!this.store.indexes.has(key)) {
          const err = new Error(
            `The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/fake/firestore/indexes?create_composite=${key}`,
          );
          err.code = 9; // google.rpc.Code.FAILED_PRECONDITION
          throw err;
        }
      }
    }
    if (this.orderField) {
      const rank = (v) => (v && typeof v === 'object' && v.__serverTs ? v.n : v);
      entries.sort((a, b) => {
        const av = rank(a[1][this.orderField]);
        const bv = rank(b[1][this.orderField]);
        if (av < bv) return this.orderDir === 'desc' ? 1 : -1;
        if (av > bv) return this.orderDir === 'desc' ? -1 : 1;
        return 0;
      });
    } else {
      // No orderBy: Firestore returns documents in DOCUMENT ID order, and a
      // limit applies to THAT order — which is why "first 30 by id" hid the
      // newest notifications until the routes started using orderBy.
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    if (this.afterValues && this.orderField) {
      const rank = (v) => (v && typeof v === 'object' && v.__serverTs ? v.n : v);
      const target = rank(this.afterValues[0]);
      // startAfter keeps only rows that come strictly AFTER the cursor in the
      // query's own sort direction (entries are already sorted here).
      let cursorIndex = -1;
      for (let i = 0; i < entries.length; i += 1) {
        if (rank(entries[i][1][this.orderField]) === target) { cursorIndex = i; break; }
      }
      if (cursorIndex >= 0) entries = entries.slice(cursorIndex + 1);
    }
    if (this.limitCount != null) entries = entries.slice(0, this.limitCount);
    return entries;
  }

  async get(merged) {
    const entries = this._rows(merged);
    const docs = entries.map(([id, data]) => makeDocSnap(this.store, this.collection, id, data));
    const snapshot = { docs, empty: docs.length === 0, size: docs.length };
    return snapshot;
  }
}

// Refs carry their collection name so transaction reads can resolve them.
function makeDocRef(store, collection, id) {
  const fullId = `${collection}/${id}`;
  return {
    id,
    path: fullId,
    collectionName: collection,
    async get() {
      const docs = store.collections.get(collection) || new Map();
      return makeDocSnap(store, collection, id, docs.get(id));
    },
    set: async (value, options) => applyWrite(store, { type: 'set', collection, id, value: deepClone(value), options }),
    update: async (value) => applyWrite(store, { type: 'update', collection, id, value: deepClone(value) }),
    delete: async () => applyWrite(store, { type: 'delete', collection, id }),
  };
}

function deepClone(value) {
  return structuredClone(value);
}

function makeDocSnap(store, collection, id, dataOrNull) {
  const exists = dataOrNull !== undefined && dataOrNull !== null;
  const data = exists ? deepClone(dataOrNull) : undefined;
  return {
    exists,
    id,
    ref: makeDocRef(store, collection, id),
    data: () => (exists ? deepClone(data) : undefined),
  };
}

async function applyWrite(store, op) {
  if (!store.collections.has(op.collection)) store.collections.set(op.collection, new Map());
  const docs = store.collections.get(op.collection);
  if (op.type === 'delete') {
    docs.delete(op.id);
  } else if (op.type === 'set') {
    const existing = docs.get(op.id) || {};
    docs.set(op.id, op.options?.merge ? { ...existing, ...op.value } : op.value);
  } else {
    if (!docs.has(op.id)) throw new Error(`FakeFirestore: cannot update missing doc ${op.collection}/${op.id}`);
    docs.set(op.id, { ...docs.get(op.id), ...op.value });
  }
}

function validateWritePaths(value, context) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key.includes('.')) {
        throw new Error(`Dotted field path in ${context}: "${key}" — inventory must be written as a whole array.`);
      }
    }
  }
}

export function createFakeDb() {
  const store = { collections: new Map(), indexes: new Set() };
  let autoId = 0;
  let serverTsCounter = 0;

  const db = {
    collection(name) {
      return {
        doc(explicitId) {
          const id = explicitId ?? `gen-${(autoId += 1)}`;
          return makeDocRef(store, name, id);
        },
        add(value) {
          const id = `gen-${(autoId += 1)}`;
          if (!store.collections.has(name)) store.collections.set(name, new Map());
          store.collections.get(name).set(id, deepClone(value));
          return Promise.resolve(makeDocRef(store, name, id));
        },
        where: (field, op, value) => new Query(store, name, [[field, value]], null, null, null).where(field, op, value),
        orderBy: (field, dir) => new Query(store, name, [], field, dir, null),
        limit: (n) => new Query(store, name, [], null, null, n),
        get: () => new Query(store, name, [], null, null, null).get(),
      };
    },
    doc(path) {
      const [name, id] = path.split('/');
      return makeDocRef(store, name, id);
    },
    // Transaction: buffers writes and applies them atomically at commit.
    // Reads inside the callback see buffered writes (latest-write-wins),
    // which matches how the route code plans reads-then-writes.
    runTransaction(asyncFn) {
      const buffer = [];
      let wrote = false;
      const assertReadBeforeWrite = () => {
        if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
      };
      const tx = {
        async get(refOrQuery) {
          assertReadBeforeWrite();
          const merged = mergedDocs(store, buffer);
          if (refOrQuery instanceof Query) return refOrQuery.get(merged);
          const collection = refOrQuery.collectionName ?? refOrQuery.path.split('/')[0];
          const docs = merged.get(collection) || new Map();
          return makeDocSnap(store, collection, refOrQuery.id, docs.get(refOrQuery.id));
        },
        getAll(...refs) {
          assertReadBeforeWrite();
          return Promise.all(refs.map(r => tx.get(r)));
        },
        set(ref, value, options) {
          validateWritePaths(value, `set ${ref.path}`);
          wrote = true;
          buffer.push({ type: 'set', collection: ref.path.split('/')[0], id: ref.id, value: deepClone(value), options });
        },
        update(ref, value) {
          validateWritePaths(value, `update ${ref.path}`);
          wrote = true;
          buffer.push({ type: 'update', collection: ref.path.split('/')[0], id: ref.id, value: deepClone(value) });
        },
        // Matches the real firebase-admin transaction API (returns a thenable).
        delete(ref) {
          wrote = true;
          buffer.push({ type: 'delete', collection: ref.path.split('/')[0], id: ref.id });
        },
      };
      return Promise.resolve(asyncFn(tx)).then(async (result) => {
        for (const op of buffer) await applyWrite(store, op);
        return result;
      });
    },
    // Test helpers -----------------------------------------------------
    __store: store,
    // Register a composite index the way firebase/firestore.indexes.json does
    // in production. where(fieldA)+orderBy(fieldB, dir) throws
    // FAILED_PRECONDITION until this is called for that combination.
    __addIndex(collectionName, fields, dir = 'asc') {
      const list = Array.isArray(fields) ? fields : [fields];
      store.indexes.add(`${collectionName}|${[...list].sort().join(',')}|${dir}`);
    },
    __seed(collectionName, id, data) {
      if (!store.collections.has(collectionName)) store.collections.set(collectionName, new Map());
      store.collections.get(collectionName).set(id, deepClone(data));
    },
    __doc(collectionName, id) {
      return (store.collections.get(collectionName) || new Map()).get(id);
    },
    __list(collectionName) {
      return [...(store.collections.get(collectionName) || new Map()).entries()].map(([id, data]) => ({ id, data: deepClone(data) }));
    },
    __serverTimestamp: () => ({ __serverTs: true, n: (serverTsCounter += 1) }),
  };
  return db;
}

function mergedDocs(store, buffer) {
  const clone = new Map();
  for (const [name, docs] of store.collections) clone.set(name, new Map(docs));
  for (const op of buffer) {
    if (!clone.has(op.collection)) clone.set(op.collection, new Map());
    const docs = clone.get(op.collection);
    if (op.type === 'set') docs.set(op.id, op.options?.merge ? { ...(docs.get(op.id) || {}), ...op.value } : op.value);
    else docs.set(op.id, { ...(docs.get(op.id) || {}), ...op.value });
  }
  return clone;
}

