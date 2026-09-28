import { WebWorkerMLCEngineHandler } from 'https://esm.run/@mlc-ai/web-llm@0.2.85';

// The model runtime is loaded only after an explicit user action in the AI report workbench.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event) => handler.onmessage(event);
