const sandboxed = require('sandboxed-lib');

try {
  const add = sandboxed.add || (sandboxed.default && sandboxed.default.add);
  const bufferSize = sandboxed.bufferSize || (sandboxed.default && sandboxed.default.bufferSize);

  if (typeof add !== 'function') {
    throw new Error('add export not available through CJS proxy');
  }

  if (typeof bufferSize !== 'function') {
    throw new Error('bufferSize export not available through CJS proxy');
  }

  const value = add(2, 3);
  const size = bufferSize(Buffer.from('hello'));

  console.log('CJS_SYNC_RESULT', value);
  console.log('CJS_SYNC_BUFFER', size);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
