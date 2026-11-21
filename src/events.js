import { EventEmitter } from "node:events";

// A small Observer-pattern example: controllers announce events; this listener logs them.
export const appEvents = new EventEmitter();

appEvents.on("login:approved", ({ requestId }) => {
  console.info(`Login request approved: ${requestId}`);
});
