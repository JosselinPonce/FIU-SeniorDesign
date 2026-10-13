import { createBackend } from './backend.ts';
import { createHandler } from './handler.ts';

// Runtime shape avoids adding Deno globals to the mobile TypeScript environment.
const runtime = (globalThis as unknown as { Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
} }).Deno;
runtime.serve(createHandler(createBackend(key => runtime.env.get(key))));
