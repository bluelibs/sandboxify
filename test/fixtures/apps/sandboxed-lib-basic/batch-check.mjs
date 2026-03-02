import { add } from 'sandboxed-lib';

const values = await add.batch([
  [1, 2],
  [3, 4],
  [5, 6],
]);

console.log('BATCH_RESULT', values.join(','));