const MediaStore = (() => {
  const DB_NAME = "local-media-toolkit";
  const DB_VERSION = 1;
  const VIDEO_STORE = "videos";
  const IMAGE_STORE = "images";
  const META_STORE = "meta";

  let dbPromise;

  async function openDb() {
    if (dbPromise) {
      try {
        return await dbPromise;
      } catch (_) {
        dbPromise = null;
      }
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(VIDEO_STORE)) {
          db.createObjectStore(VIDEO_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败"));
    });

    try {
      return await dbPromise;
    } catch (error) {
      dbPromise = null;
      throw error;
    }
  }

  async function withStore(storeName, mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const result = callback(store, transaction);

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("数据库事务失败"));
      transaction.onabort = () => reject(transaction.error || new Error("数据库事务中止"));
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("数据库请求失败"));
    });
  }

  return {
    async getAllVideos() {
      return withStore(VIDEO_STORE, "readonly", (store) => requestToPromise(store.getAll()));
    },
    async putVideo(record) {
      return withStore(VIDEO_STORE, "readwrite", (store) => requestToPromise(store.put(record)));
    },
    async putVideos(records) {
      if (!records.length) return;
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(VIDEO_STORE, "readwrite");
        const store = transaction.objectStore(VIDEO_STORE);
        for (const record of records) {
          const req = store.put(record);
          req.onerror = () => reject(req.error || new Error("数据库写入失败"));
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("数据库事务失败"));
        transaction.onabort = () => reject(transaction.error || new Error("数据库事务中止"));
      });
    },
    async clearVideos() {
      return withStore(VIDEO_STORE, "readwrite", (store) => requestToPromise(store.clear()));
    },
    async getImageState() {
      return withStore(IMAGE_STORE, "readonly", (store) => requestToPromise(store.get("current")));
    },
    async putImageState(record) {
      return withStore(IMAGE_STORE, "readwrite", (store) => requestToPromise(store.put({ id: "current", ...record })));
    },
    async clearImageState() {
      return withStore(IMAGE_STORE, "readwrite", (store) => requestToPromise(store.delete("current")));
    },
    async getFrameTransfer() {
      return withStore(IMAGE_STORE, "readonly", (store) => requestToPromise(store.get("frame-transfer")));
    },
    async putFrameTransfer(record) {
      return withStore(IMAGE_STORE, "readwrite", (store) => requestToPromise(store.put({ id: "frame-transfer", ...record })));
    },
    async clearFrameTransfer() {
      return withStore(IMAGE_STORE, "readwrite", (store) => requestToPromise(store.delete("frame-transfer")));
    },
    async getMeta(key) {
      const record = await withStore(META_STORE, "readonly", (store) => requestToPromise(store.get(key)));
      return record ? record.value : null;
    },
    async setMeta(key, value) {
      return withStore(META_STORE, "readwrite", (store) => requestToPromise(store.put({ key, value })));
    },
  };
})();
