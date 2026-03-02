import fs from 'node:fs';

async function main() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = decodeWireValue(JSON.parse(raw || '{}'));
    const value = await dispatch(payload);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        value: encodeWireValue(value),
      }),
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: serializeError(error),
      }),
    );
  }
}

async function dispatch(payload) {
  const moduleUrl = payload?.url;
  const exportName = payload?.exportName;
  const args = Array.isArray(payload?.args) ? payload.args : [];

  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new Error('Missing module URL for sync call payload');
  }

  if (typeof exportName !== 'string' || exportName.length === 0) {
    throw new Error('Missing export name for sync call payload');
  }

  const namespace = await import(moduleUrl);
  const target = namespace[exportName];

  if (typeof target !== 'function') {
    throw new Error(`Export "${exportName}" is not callable`);
  }

  const result = await target(...args);
  return { result };
}

function encodeWireValue(value) {
  if (Buffer.isBuffer(value)) {
    return {
      __sandboxifyType: 'buffer',
      base64: value.toString('base64'),
    };
  }

  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => encodeWireValue(entry));
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = encodeWireValue(entry);
    }
    return output;
  }

  throw new Error(
    `Experimental CJS sync mode only supports JSON-compatible values and Buffer payloads. Unsupported type: ${value?.constructor?.name ?? typeof value}`,
  );
}

function decodeWireValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => decodeWireValue(entry));
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    if (value.__sandboxifyType === 'buffer') {
      return Buffer.from(value.base64 ?? '', 'base64');
    }

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = decodeWireValue(entry);
    }
    return output;
  }

  throw new Error('Experimental CJS sync mode received unsupported wire value');
}

function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    data: error?.data,
  };
}

void main();
