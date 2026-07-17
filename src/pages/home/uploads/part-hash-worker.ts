import { createMD5 } from "hash-wasm"

interface WorkerProgressMessage {
  type: "progress"
  progress: number
}

interface WorkerResultMessage {
  type: "result"
  hashes: string[]
}

interface WorkerErrorMessage {
  type: "error"
  error: string
}

export type PartHashWorkerMessage =
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerErrorMessage

self.onmessage = async (e: MessageEvent<{ file: File; chunkSize: number }>) => {
  const { file, chunkSize } = e.data
  try {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("Invalid hash chunk size")
    }
    const hashes: string[] = []
    let loaded = 0
    for (let start = 0; start < file.size; start += chunkSize) {
      const chunk = file.slice(start, Math.min(start + chunkSize, file.size))
      const digest = await createMD5()
      const reader = chunk.stream().getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        digest.update(value)
        loaded += value.length
        self.postMessage({
          type: "progress",
          progress: (loaded / file.size) * 100,
        } satisfies WorkerProgressMessage)
      }
      hashes.push(digest.digest("hex"))
    }
    self.postMessage({ type: "result", hashes } satisfies WorkerResultMessage)
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerErrorMessage)
  }
}
