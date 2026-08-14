let nextReferenceId = 0;

const objectIds = new WeakMap<object, number>();
const symbolIds = new Map<symbol, number>();

const nextId = (): number => {
  nextReferenceId += 1;
  return nextReferenceId;
};

/**
 * A render-safe identity token with the same equality semantics as a React
 * dependency: primitives use `Object.is`, objects and functions use reference
 * identity. Unlike JSON serialisation it handles cycles, bigint, symbols, and
 * functions without collisions or throws.
 */
export const identityOf = (value: unknown): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return `boolean:${value}`;
    case 'string':
      return `string:${JSON.stringify(value)}`;
    case 'number':
      if (Number.isNaN(value)) return 'number:NaN';
      if (Object.is(value, -0)) return 'number:-0';
      return `number:${value}`;
    case 'bigint':
      return `bigint:${value}`;
    case 'symbol': {
      let id = symbolIds.get(value);
      if (id === undefined) {
        id = nextId();
        symbolIds.set(value, id);
      }
      return `symbol:${id}`;
    }
    case 'function':
    case 'object': {
      const reference = value as object;
      let id = objectIds.get(reference);
      if (id === undefined) {
        id = nextId();
        objectIds.set(reference, id);
      }
      return `reference:${id}`;
    }
    default:
      throw new TypeError(`Unsupported dependency type: ${typeof value}`);
  }
};

export const identityOfList = (values: readonly unknown[] = []): string =>
  JSON.stringify(values.map(identityOf));

/** Preserve the existing value-based convenience for inline JSON payloads. */
export const structuralIdentityOf = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return `json:${json}`;
  } catch {
    // Cyclic and bigint values fall back to reference/Object.is identity.
  }
  return identityOf(value);
};
