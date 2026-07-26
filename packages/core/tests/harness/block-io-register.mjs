// Preload (`node --import`) for the import-smoke child. Registers the I/O
// blocking loader hook and empties process.env, so the child runs with no
// ambient environment and no ability to reach fs / child_process / net / http /
// https / dns.
import { register } from 'node:module'

register('./block-io-hooks.mjs', import.meta.url)

for (const key of Object.keys(process.env)) {
  delete process.env[key]
}
