const { Blob } = require('node:buffer');

if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = Blob;
}

if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends globalThis.Blob {
    constructor(parts = [], name = '', options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = Number.isFinite(options.lastModified) ? options.lastModified : Date.now();
    }
  };
}
