export const REMOTE_REFERENCE = Symbol("sandboxify.remoteReference");
export const HOST_REFERENCE_TAG = "__sandboxifyHostRef";
export const CLIENT_REFERENCE_TAG = "__sandboxifyClientRef";

export function getRemoteReference(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return null;
  }

  return value[REMOTE_REFERENCE] ?? null;
}

export function isEncodedHostReference(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    value[HOST_REFERENCE_TAG] === 1 &&
    Number.isInteger(value.handleId)
  );
}

export function isEncodedClientReference(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    value[CLIENT_REFERENCE_TAG] === 1 &&
    Number.isInteger(value.handleId)
  );
}

export function appendHostReferencePath(reference, propertyName) {
  if (!isEncodedHostReference(reference) || typeof propertyName !== "string") {
    return reference;
  }

  return {
    ...reference,
    path: [
      ...(Array.isArray(reference.path) ? reference.path : []),
      propertyName,
    ],
  };
}
