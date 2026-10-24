// Lightweight part of the sound feature, safe to import from the service
// worker (the audio engine itself lives in listen.js / shazam.js).
import { loadEntry, storeEntry } from "./session.js";

export const LISTEN_SECONDS = 12;

const KEEP_RECORDINGS = 3;

export const storeRecording = (entry) => storeEntry("snd", entry, KEEP_RECORDINGS);
export const loadRecording = (id) => loadEntry("snd", id);
