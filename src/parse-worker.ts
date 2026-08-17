import { parentPort, workerData } from 'worker_threads'
import { restorePricingState, type PricingSnapshot } from './models.js'
import { parseClaudeFileFull } from './parser.js'

const port = parentPort
if (!port) throw new Error('parse-worker must be started as a worker thread')

restorePricingState((workerData as { pricing: PricingSnapshot }).pricing)

// The parsed turns go back as a JSON string rather than as a live object graph:
// structured-cloning a whole corpus of turns costs more than the parallel parse
// saves, while a string is a single copy the parent re-parses at memcpy speed.
// `msgIds` is every streaming message id this file claimed; the parent uses it to
// prove no earlier file already owned one before installing the result.
port.on('message', (msg: { filePath: string }) => {
  void (async () => {
    try {
      const seenMsgIds = new Set<string>()
      const parsed = await parseClaudeFileFull(msg.filePath, seenMsgIds)
      port.postMessage({ json: parsed === null ? null : JSON.stringify({ ...parsed, msgIds: [...seenMsgIds] }) })
    } catch (err) {
      port.postMessage({ error: err instanceof Error ? err.message : String(err) })
    }
  })()
})
