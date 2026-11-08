// fake-folder.js — an in-memory stand-in for window.showDirectoryPicker (File
// System Access API) so tests can exercise "save to folder" without a native
// dialog. Written files are kept in window.__fakeFolderFiles as text, keyed by
// path relative to the picked folder.
(function () {
  const files = (window.__fakeFolderFiles = {});
  class FakeWritable {
    constructor(path, keep) {
      this.path = path;
      this.buf = keep && files[path] ? files[path] : '';
      this.pos = this.buf.length;
    }
    async seek(n) {
      this.pos = n;
    }
    async write(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk instanceof Blob ? await chunk.text() : new TextDecoder().decode(chunk);
      this.buf = this.buf.slice(0, this.pos) + text;
      this.pos = this.buf.length;
    }
    async close() {
      files[this.path] = this.buf;
    }
  }
  class FakeFileHandle {
    constructor(path) {
      this.kind = 'file';
      this.path = path;
      this.name = path.split('/').pop();
    }
    async getFile() {
      return new File([files[this.path] || ''], this.name);
    }
    async createWritable(opts) {
      return new FakeWritable(this.path, !!opts?.keepExistingData);
    }
  }
  class FakeDirectoryHandle {
    constructor(path, name) {
      this.kind = 'directory';
      this.path = path;
      this.name = name;
    }
    async queryPermission() {
      return 'granted';
    }
    async requestPermission() {
      return 'granted';
    }
    async getDirectoryHandle(name, opts) {
      const path = this.path ? `${this.path}/${name}` : name;
      const exists = Object.keys(files).some((k) => k.startsWith(path + '/'));
      if (!exists && !opts?.create) throw new DOMException('not found', 'NotFoundError');
      return new FakeDirectoryHandle(path, name);
    }
    async getFileHandle(name) {
      return new FakeFileHandle(this.path ? `${this.path}/${name}` : name);
    }
    async removeEntry(name, opts) {
      const prefix = (this.path ? `${this.path}/${name}` : name) + '/';
      const keys = Object.keys(files).filter((k) => k.startsWith(prefix) || k === prefix.slice(0, -1));
      if (!keys.length) throw new DOMException('not found', 'NotFoundError');
      if (keys.length > 1 && !opts?.recursive) throw new DOMException('not empty', 'InvalidModificationError');
      for (const k of keys) delete files[k];
      window.__fakeFolderRemoved = (window.__fakeFolderRemoved || []).concat(prefix.slice(0, -1));
    }
  }
  window.showDirectoryPicker = async () => new FakeDirectoryHandle('', 'FakeFolder');
  console.log('[fake-folder] in-memory folder picker installed');
})();
