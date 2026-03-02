export function makePayload(type, sizeBytes) {
  if (type === 'buffer') {
    return Buffer.alloc(sizeBytes, 97);
  }

  if (type === 'uint8array') {
    return new Uint8Array(sizeBytes).fill(7);
  }

  if (type === 'json') {
    return {
      tag: 'json',
      bytes: sizeBytes,
      data: 'x'.repeat(sizeBytes),
    };
  }

  throw new Error(`Unknown payload type: ${type}`);
}

export function estimatePayloadBytes(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload.byteLength;
  }

  if (payload instanceof Uint8Array) {
    return payload.byteLength;
  }

  if (payload && typeof payload === 'object') {
    return Buffer.byteLength(JSON.stringify(payload));
  }

  return 0;
}
