export class Library {
  constructor({
    indexedDB = globalThis.indexedDB,
    name = "diyfm-library-v2",
  } = {}) {
    this.ready = new Promise((resolve, reject) => {
      if (!indexedDB)
        return reject(
          new Error(
            "浏览器未提供 IndexedDB，无法安全保存成片。请关闭受限模式或换一个浏览器。",
          ),
        );
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onsuccess = () => {
        this.db = open.result;
        this.db.onversionchange = () => this.db.close();
        resolve();
      };
      open.onerror = () =>
        reject(new Error("无法打开浏览器节目库，请检查存储权限。"));
    });
  }
  async get(key) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const r = this.db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () =>
        reject(new Error("节目库读取失败，请检查浏览器存储权限。"));
    });
  }
  async entries() {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("kv"),
        s = tx.objectStore("kv"),
        keys = s.getAllKeys(),
        values = s.getAll();
      tx.oncomplete = () =>
        resolve(keys.result.map((key, i) => [key, values.result[i]]));
      tx.onerror = () => reject(new Error("节目库读取失败。"));
    });
  }
  async mutate(key, change) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("kv", "readwrite"),
        s = tx.objectStore("kv"),
        get = s.get(key);
      let result, error;
      get.onsuccess = () => {
        try {
          const changed = change(get.result);
          result = changed.result;
          for (const [k, v] of changed.puts || []) s.put(v, k);
          for (const k of changed.deletes || []) s.delete(k);
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          error ||
            new Error(
              "浏览器未能保存结果，可能存储空间不足。原有成片仍保留，请先导出备份。",
            ),
        );
      tx.onerror = () => {};
    });
  }
  async write(puts = [], deletes = []) {
    return this.mutate("__transaction__", () => ({ puts, deletes }));
  }
}
