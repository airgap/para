// Extraction fixtures — para-extract test suite.

export interface User {
  id: bigint;
  name: string;
  bio?: string;
  tags: string[];
}

export interface Comment {
  body: string;
  replies: Comment[];
}

export interface Post {
  title: string;
  comments: Thread[];
}

export interface Thread {
  body: string;
  post?: Post;
}

export type Status = "active" | "banned" | "deleted";

export type Mixed = "a" | 1 | true;

export type StringOrNumber = string | number;

export type UserId = `user-${number}`;

export interface Timestamps {
  created: Date;
  updated?: Date;
}

export interface Nullable {
  note: string | null;
  score: number | undefined;
}

export interface WithFn {
  handler: () => void;
}

export interface Bad {
  lookup: Map<string, number>;
}

export interface Anon {
  nested: { deep: { leaf: string } };
}

interface Hidden {
  next: Hidden[];
}
export interface UsesHidden {
  h: Hidden;
}
