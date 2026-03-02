import { bufferSize } from 'sandboxed-lib';

console.log('BUFFER_SIZE', await bufferSize(Buffer.from('hello')));