import { createAskBackend } from './backend.ts';
import { createAskHandler } from './handler.ts';

const runtime = (globalThis as unknown as { Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
} }).Deno;
runtime.serve(createAskHandler(createAskBackend(key => runtime.env.get(key))));
