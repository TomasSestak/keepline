/**
 * Type-only copy of the Standard Schema v1 spec.
 *
 * Vendored (rather than depending on `@standard-schema/spec`) so that
 * `keepline/core` keeps a genuinely empty dependency list — including type
 * dependencies, which otherwise leak into consumers' `node_modules`.
 *
 * Source: https://github.com/standard-schema/standard-schema (MIT)
 * Spec:   https://standardschema.dev
 *
 * Any library implementing the spec works as a `schema` option: zod >= 3.24,
 * valibot >= 1.0, arktype >= 2.0, effect/Schema, and others.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/** Human-readable rendering of schema issues, for logs and error messages. */
export const formatIssues = (
  issues: ReadonlyArray<StandardSchemaV1.Issue>
): string =>
  issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) =>
          typeof segment === 'object' && segment !== null && 'key' in segment
            ? String(segment.key)
            : String(segment)
        )
        .join('.');

      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
