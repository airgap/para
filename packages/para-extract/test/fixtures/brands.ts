// Brand + checker-resolution fixtures (extractor plan step 4).
import type { ArrayOf, BigIntOf, BooleanOf, NumberOf, StringOf } from "@lyku/para-schema";

export type Username = StringOf<{ minLength: 3; maxLength: 32; pattern: "^[A-Za-z0-9_]+$" }>;
export type Email = StringOf<{ format: "email" }>;
export type Age = NumberOf<{ integer: true; minimum: 0; maximum: 150 }>;
export type Ratio = NumberOf<{ minimum: 0; maximum: 1 }>;
export type Snowflake = BigIntOf<{ minimum: 0n }>;
export type Huge = BigIntOf<{ minimum: 9007199254740993n }>;
export type AlwaysTrue = BooleanOf<{ const: true }>;
export type Tags = ArrayOf<string, { minItems: 1; maxItems: 10 }>;

export interface Account {
  id: Snowflake;
  username: Username;
  email?: Email;
  age: Age;
  tags: Tags;
}

// Plain object intersection (non-brand).
export type Merged = { a: string } & { b?: number };

// Checker-resolution stress: mapped and conditional types resolve at
// extraction time (recursion plan §3).
export type PartialAccount = Partial<Pick<Account, "username" | "age">>;
export type Flags = { [K in "read" | "write"]: boolean };
type PickByKind<T, K> = K extends "str" ? { value: string } : { value: T };
export type CondStr = PickByKind<number, "str">;
export type CondNum = PickByKind<number, "num">;
