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
    async getDirectoryHandle(name) {
      return new FakeDirectoryHandle(this.path ? `${this.path}/${name}` : name, name);
    }
    async getFileHandle(name) {
      return new FakeFileHandle(this.path ? `${this.path}/${name}` : name);
    }
  }
  window.showDirectoryPicker = async () => new FakeDirectoryHandle('', 'FakeFolder');
  console.log('[fake-folder] in-memory folder picker installed');
})();
