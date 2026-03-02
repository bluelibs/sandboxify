import { tryChild } from 'sandboxed-lib';

try {
  const out = await tryChild();
  console.log('CHILD_OK', out);
} catch (error) {
  console.log('CHILD_ERR', error.code || error.name);
}