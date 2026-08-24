const { contextBridge } = require('electron');

const calls = [];
let fleetCallback = null;
let lastSubmissionId = null;
const api = {
  say: (text, _images, submissionId) => { lastSubmissionId = submissionId || null; calls.push({ type: 'say', text }); },
  dispatch: (task, cwd, mode) => calls.push({ type: 'dispatch', task, cwd, mode }),
  setAutonomy: () => {},
  replyAgent: () => {},
  selfBuild: () => {},
  cancel: (id, submissionId) => calls.push({ type: 'cancel', id, ...(submissionId ? { submissionId } : {}) }),
  readMemory: () => {},
  readRuns: () => {},
  exportConversation: () => {},
  readDoc: () => {},
  listDocs: () => {},
  readGraph: () => {},
  stationHealth: async () => ({}),
  estate: async () => ({}),
  wall: async () => ({}),
  discover: async () => ({}),
  onFleet: (callback) => { fleetCallback = callback; },
  emitFleet: (message) => { if (fleetCallback) fleetCallback(message); },
  getCalls: () => calls.slice(),
  getLastSubmissionId: () => lastSubmissionId,
  clearCalls: () => { calls.length = 0; },
};

contextBridge.exposeInMainWorld('atlas', api);
